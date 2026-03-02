package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"gopkg.in/yaml.v3"
	"nhooyr.io/websocket"
)

var version = "dev"

type DirectiveCommand struct {
	Argv     []string   `yaml:"argv" json:"argv"`
	ArgvList [][]string `yaml:"argv_list" json:"argv_list"`
}

type Rule struct {
	Condition string           `yaml:"condition" json:"condition"`
	Action    string           `yaml:"action" json:"action"`
	Command   DirectiveCommand `yaml:"command" json:"command"`
}

type Field struct {
	Type        string `yaml:"type" json:"type"`
	Description string `yaml:"description" json:"description"`
}

type Directive struct {
	Name  string `yaml:"name" json:"name"`
	Rules []Rule `yaml:"rules" json:"rules"`
	Field Field  `yaml:"field" json:"field"`
}

type DirectivesFile map[string]Directive

type WSMsg map[string]any

func main() {
	var (
		workerURL         = flag.String("worker-url", "http://127.0.0.1:8787", "Worker base URL")
		agentID           = flag.String("agent-id", "", "Agent/router id")
		displayName       = flag.String("display-name", "", "Human-readable display name (supports spaces and emojis)")
		secret            = flag.String("secret", "", "Shared secret")
		pubkey            = flag.String("pubkey", "", "ssh-ed25519 public key (single-line) used to verify directives.yml.sig")
		signerIdentity    = flag.String("signer-identity", "lg-directives", "ssh-keygen signer identity (principal) used in allowed signers")
		signerNamespace   = flag.String("signer-namespace", "lg-directives", "ssh-keygen namespace used for signing")
		fetchInterval     = flag.Duration("directives-fetch-interval", 5*time.Minute, "How often to fetch directives.yml + .sig")
		heartbeatInterval = flag.Duration("heartbeat-interval", 30*time.Second, "Agent heartbeat interval")
		keepaliveInterval = flag.Duration("keepalive-interval", 2*time.Second, "Keepalive interval during command execution")
		writeTimeout      = flag.Duration("ws-write-timeout", 2*time.Second, "WS write timeout (best-effort; drops on timeout)")
		sourceV4          = flag.String("source-v4", "", "Source IPv4 address for {source_v4} substitution in directives")
		sourceV6          = flag.String("source-v6", "", "Source IPv6 address for {source_v6} substitution in directives")
	)
	flag.Parse()

	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		fmt.Fprintf(os.Stderr, "warning: intended for linux/amd64; running on %s/%s\n", runtime.GOOS, runtime.GOARCH)
	}
	if *agentID == "" {
		exitf("-agent-id is required")
	}
	if *secret == "" {
		exitf("-secret is required")
	}
	if *pubkey == "" {
		exitf("-pubkey is required")
	}

	base, err := url.Parse(*workerURL)
	if err != nil {
		exitf("invalid worker url: %v", err)
	}

	m := &manager{
		base:            base,
		client:          &http.Client{Timeout: 10 * time.Second},
		pubkey:          *pubkey,
		signerIdentity:  *signerIdentity,
		signerNamespace: *signerNamespace,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initial fetch is required.
	if err := m.fetchAndLoad(ctx); err != nil {
		exitf("initial directives fetch failed: %v", err)
	}

	go func() {
		t := time.NewTicker(*fetchInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = m.fetchAndLoad(ctx) // best-effort; keep last good
			}
		}
	}()

	ag := &agent{
		base:           base,
		agentID:        *agentID,
		displayName:    *displayName,
		secret:         *secret,
		heartbeatEvery: *heartbeatInterval,
		keepaliveEvery: *keepaliveInterval,
		writeTimeout:   *writeTimeout,
		directives:     m,
		activeCancels:  map[string]context.CancelFunc{},
		sourceV4:       *sourceV4,
		sourceV6:       *sourceV6,
	}

	if err := ag.run(ctx); err != nil {
		exitf("agent stopped: %v", err)
	}
}

type manager struct {
	base            *url.URL
	client          *http.Client
	pubkey          string
	signerIdentity  string
	signerNamespace string

	cur atomic.Value // *loaded
}

type loaded struct {
	yamlText string
	sigText  string
	hash     string
	dirs     DirectivesFile
}

func (m *manager) get() *loaded {
	v := m.cur.Load()
	if v == nil {
		return nil
	}
	return v.(*loaded)
}

func (m *manager) hash() string {
	l := m.get()
	if l == nil {
		return ""
	}
	return l.hash
}

func (m *manager) directives() (DirectivesFile, bool) {
	l := m.get()
	if l == nil {
		return nil, false
	}
	return l.dirs, true
}

func (m *manager) fetchAndLoad(ctx context.Context) error {
	yamlURL := *m.base
	yamlURL.Path = "/directives.yml"
	sigURL := *m.base
	sigURL.Path = "/directives.yml.sig"

	yamlText, err := httpGetText(ctx, m.client, yamlURL.String())
	if err != nil {
		return fmt.Errorf("fetch directives.yml: %w", err)
	}
	sigText, err := httpGetText(ctx, m.client, sigURL.String())
	if err != nil {
		return fmt.Errorf("fetch directives.yml.sig: %w", err)
	}

	// Verify signature
	if err := verifySig(ctx, m.pubkey, m.signerIdentity, m.signerNamespace, yamlText, sigText); err != nil {
		return fmt.Errorf("signature verify failed: %w", err)
	}

	// Parse YAML
	var dirs DirectivesFile
	if err := yaml.Unmarshal([]byte(yamlText), &dirs); err != nil {
		return fmt.Errorf("parse directives.yml: %w", err)
	}

	// Compute hash
	sum := sha256.Sum256([]byte(yamlText))
	h := hex.EncodeToString(sum[:])

	prev := m.get()
	if prev != nil && prev.hash == h {
		return nil
	}

	m.cur.Store(&loaded{yamlText: yamlText, sigText: sigText, hash: h, dirs: dirs})
	fmt.Fprintf(os.Stderr, "directives loaded: hash=%s\n", h)
	return nil
}

func httpGetText(ctx context.Context, c *http.Client, u string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return "", err
	}
	fmt.Fprintf(os.Stderr, "[http] GET %s\n", u)
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	fmt.Fprintf(os.Stderr, "[http] %s\n", resp.Status)
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func verifySig(ctx context.Context, pubkey, signerIdentity, signerNamespace, yamlText, sigText string) error {
	// ssh-keygen -Y verify requires an "allowed signers" file.
	// We'll write a temp file with: <identity> <publickey>
	// and then feed directives.yml on stdin.
	if strings.TrimSpace(sigText) == "" {
		return errors.New("empty signature")
	}
	if !strings.HasPrefix(strings.TrimSpace(pubkey), "ssh-ed25519 ") {
		return errors.New("pubkey must start with 'ssh-ed25519 '")
	}

	tmp, err := os.MkdirTemp("", "lg-agent-verify-*\n")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	allowed := filepath.Join(tmp, "allowed_signers")
	sigFile := filepath.Join(tmp, "directives.yml.sig")

	if err := os.WriteFile(allowed, []byte(fmt.Sprintf("%s %s\n", signerIdentity, strings.TrimSpace(pubkey))), 0600); err != nil {
		return err
	}
	if err := os.WriteFile(sigFile, []byte(sigText), 0600); err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, "ssh-keygen",
		"-Y", "verify",
		"-f", allowed,
		"-I", signerIdentity,
		"-n", signerNamespace,
		"-s", sigFile,
	)
	cmd.Stdin = strings.NewReader(yamlText)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ssh-keygen verify failed: %w (%s)", err, strings.TrimSpace(out.String()))
	}
	return nil
}

type agent struct {
	base           *url.URL
	agentID        string
	displayName    string
	secret         string
	heartbeatEvery time.Duration
	keepaliveEvery time.Duration
	writeTimeout   time.Duration
	sourceV4       string
	sourceV6       string

	directives *manager

	mu            sync.Mutex
	activeCancels map[string]context.CancelFunc
}

func (a *agent) run(ctx context.Context) error {
	wsURL := *a.base
	if wsURL.Scheme == "https" {
		wsURL.Scheme = "wss"
	} else {
		wsURL.Scheme = "ws"
	}
	wsURL.Path = "/ws/agent/" + url.PathEscape(a.agentID)

	c, _, err := websocket.Dial(ctx, wsURL.String(), nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "bye")

	// Register
	reg := WSMsg{
		"type":            "register",
		"agent_id":        a.agentID,
		"secret":          a.secret,
		"version":         "0.1.0",
		"directives_hash": a.directives.hash(),
	}
	if a.displayName != "" {
		reg["display_name"] = a.displayName
	}
	_ = a.writeJSONBestEffort(ctx, c, reg)

	// Heartbeats
	go func() {
		t := time.NewTicker(a.heartbeatEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = a.writeJSONBestEffort(ctx, c, WSMsg{"type": "heartbeat", "agent_id": a.agentID, "directives_hash": a.directives.hash()})
			}
		}
	}()

	// Read loop
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "[ws recv] %s\n", string(data))
		var msg WSMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch msg["type"] {
		case "exec":
			go a.handleExec(ctx, c, msg)
		case "cancel":
			job := fmt.Sprint(msg["job"])
			a.cancelJob(job)
		default:
			// ignore
		}
	}
}

func (a *agent) cancelJob(job string) {
	a.mu.Lock()
	cancel, ok := a.activeCancels[job]
	a.mu.Unlock()
	if ok {
		cancel()
	}
}

func (a *agent) handleExec(parent context.Context, c *websocket.Conn, msg WSMsg) {
	job := fmt.Sprint(msg["job"])
	directiveID := fmt.Sprint(msg["directive"])
	target := fmt.Sprint(msg["target"])

	if job == "" || directiveID == "" || target == "" {
		return
	}
	if strings.ContainsAny(target, " \t\n") {
		_ = a.writeJSONBestEffort(parent, c, WSMsg{"type": "exit", "job": job, "code": 2})
		return
	}
	ip := net.ParseIP(target)
	if ip == nil {
		_ = a.writeJSONBestEffort(parent, c, WSMsg{"type": "exit", "job": job, "code": 2})
		return
	}

	timeoutMS, _ := toInt(msg["timeout_ms"])
	if timeoutMS <= 0 {
		timeoutMS = 30000
	}

	execCtx, cancel := context.WithTimeout(parent, time.Duration(timeoutMS)*time.Millisecond)
	a.mu.Lock()
	a.activeCancels[job] = cancel
	a.mu.Unlock()
	defer func() {
		cancel()
		a.mu.Lock()
		delete(a.activeCancels, job)
		a.mu.Unlock()
	}()

	dirs, ok := a.directives.directives()
	if !ok {
		_ = a.writeJSONBestEffort(parent, c, WSMsg{"type": "exit", "job": job, "code": 1})
		return
	}
	dir, ok := dirs[directiveID]
	if !ok {
		_ = a.writeJSONBestEffort(parent, c, WSMsg{"type": "exit", "job": job, "code": 1})
		return
	}

	argvLists, permitted := selectCommand(dir, target)
	if !permitted {
		_ = a.writeJSONBestEffort(parent, c, WSMsg{"type": "exit", "job": job, "code": 1})
		return
	}

	seq := int64(0)
	keepaliveDone := make(chan struct{})
	go func() {
		t := time.NewTicker(a.keepaliveEvery)
		defer t.Stop()
		for {
			select {
			case <-keepaliveDone:
				return
			case <-execCtx.Done():
				return
			case <-t.C:
				_ = a.writeJSONBestEffort(parent, c, WSMsg{"type": "keepalive", "job": job, "ts": time.Now().Unix()})
			}
		}
	}()

	exitCode := 0
	for _, argv := range argvLists {
		argv = substituteArgs(argv, target, a.sourceV4, a.sourceV6)
		code, err := runOne(execCtx, c, job, &seq, argv)
		if err != nil {
			exitCode = code
			break
		}
		exitCode = code
	}

	close(keepaliveDone)
	_ = a.writeJSONBestEffort(parent, c, WSMsg{"type": "exit", "job": job, "code": exitCode})
}

func selectCommand(d Directive, target string) ([][]string, bool) {
	for _, r := range d.Rules {
		if !ruleMatches(r.Condition, target) {
			continue
		}
		if strings.ToLower(r.Action) != "permit" {
			return nil, false
		}
		if len(r.Command.Argv) > 0 {
			return [][]string{r.Command.Argv}, true
		}
		if len(r.Command.ArgvList) > 0 {
			return r.Command.ArgvList, true
		}
		return nil, false
	}
	return nil, false
}

func ruleMatches(cond, target string) bool {
	cond = strings.TrimSpace(cond)
	if cond == "" {
		return false
	}
	// CIDR match
	if strings.Contains(cond, "/") {
		if _, n, err := net.ParseCIDR(cond); err == nil {
			ip := net.ParseIP(target)
			if ip == nil {
				return false
			}
			return n.Contains(ip)
		}
	}
	// regex match
	re, err := regexp.Compile(cond)
	if err != nil {
		return false
	}
	return re.MatchString(target)
}

func substituteArgs(argv []string, target, sourceV4, sourceV6 string) []string {
	out := make([]string, 0, len(argv))
	for _, a := range argv {
		a = strings.ReplaceAll(a, "{target}", target)
		a = strings.ReplaceAll(a, "{source_v4}", sourceV4)
		a = strings.ReplaceAll(a, "{source_v6}", sourceV6)
		out = append(out, a)
	}
	return out
}

func runOne(ctx context.Context, c *websocket.Conn, job string, seq *int64, argv []string) (int, error) {
	if len(argv) == 0 {
		return 1, errors.New("empty argv")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 1, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 1, err
	}

	if err := cmd.Start(); err != nil {
		return 1, err
	}

	errCh := make(chan error, 2)
	go streamPipe(ctx, c, job, "stdout", stdout, seq, errCh)
	go streamPipe(ctx, c, job, "stderr", stderr, seq, errCh)

	waitErr := cmd.Wait()
	// Wait for streams to drain (best-effort)
	for i := 0; i < 2; i++ {
		select {
		case <-ctx.Done():
			// ignore
		case <-errCh:
			// ignore
		case <-time.After(500 * time.Millisecond):
			// ignore
		}
	}

	if waitErr == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(waitErr, &ee) {
		return ee.ExitCode(), waitErr
	}
	return 1, waitErr
}

func streamPipe(ctx context.Context, c *websocket.Conn, job, stream string, r io.Reader, seq *int64, done chan<- error) {
	defer func() { done <- nil }()
	br := bufio.NewReaderSize(r, 16*1024)
	buf := make([]byte, 4096)
	for {
		n, err := br.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])
			id := atomic.AddInt64(seq, 1)
			_ = writeJSONDrop(ctx, c, 2*time.Second, WSMsg{"type": "chunk", "job": job, "seq": id, "stream": stream, "data": chunk})
		}
		if err != nil {
			return
		}
	}
}

func (a *agent) writeJSONBestEffort(ctx context.Context, c *websocket.Conn, m WSMsg) error {
	return writeJSONDrop(ctx, c, a.writeTimeout, m)
}

func writeJSONDrop(parent context.Context, c *websocket.Conn, timeout time.Duration, m WSMsg) error {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	b, _ := json.Marshal(m)
	fmt.Fprintf(os.Stderr, "[ws send] %s\n", string(b))
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		// Drop on timeout or transient error (no resend requirement).
		return err
	}
	return nil
}

func toInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case json.Number:
		i, err := t.Int64()
		return int(i), err == nil
	case string:
		i := 0
		_, err := fmt.Sscanf(t, "%d", &i)
		return i, err == nil
	default:
		return 0, false
	}
}

func exitf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
