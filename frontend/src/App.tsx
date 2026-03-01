import Anser from "ansi-to-react";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentInfo, getAgents, getConfig, getDirectives } from "@/lib/api";
import { resolveDNS, resolveBoth } from "@/lib/dns";
import { detectAddressFamily } from "@/lib/directive";
import { isIPAddress } from "@/lib/ip";

interface OutputChunk {
  seq: number;
  data: string;
}

function binaryInsertChunk(
  chunks: OutputChunk[],
  newChunk: OutputChunk,
): OutputChunk[] {
  let lo = 0;
  let hi = chunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].seq < newChunk.seq) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const result = chunks.slice(0, lo);
  result.push(newChunk);
  result.push(...chunks.slice(lo));
  return result;
}

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: any) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

function wsUrl(path: string): string {
  const u = new URL(window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = path;
  u.search = "";
  u.hash = "";
  return u.toString();
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export interface TurnstileHandle {
  reset: () => void;
}

const TurnstileBox = forwardRef<
  TurnstileHandle,
  { sitekey: string; onToken: (t: string) => void }
>(function TurnstileBox(props, ref) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    },
  }));

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    let cancelled = false;

    const tryRender = () => {
      if (cancelled) return;
      if (!window.turnstile) {
        setTimeout(tryRender, 100);
        return;
      }
      if (widgetIdRef.current) return;

      const id = window.turnstile.render(el, {
        sitekey: props.sitekey,
        callback: (token: string) => props.onToken(token),
      });
      widgetIdRef.current = id;
    };

    tryRender();

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [props.sitekey]);

  return (
    <div>
      <div ref={innerRef} />
    </div>
  );
});

export function App() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showErrorModal, setShowErrorModal] = useState(false);

  const [sitekey, setSitekey] = useState<string>("");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [directives, setDirectives] = useState<Record<string, any>>({});

  const [agentId, setAgentId] = useState<string>("");
  const [directiveId, setDirectiveId] = useState<string>("");
  const [target, setTarget] = useState<string>("");

  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const turnstileRef = useRef<TurnstileHandle>(null);

  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState<string>("");
  const [chunks, setChunks] = useState<OutputChunk[]>([]);

  const [resolving, setResolving] = useState(false);
  const [resolvedIPs, setResolvedIPs] = useState<{
    hostname: string;
    v4: string[];
    v6: string[];
  } | null>(null);
  const [showIPDialog, setShowIPDialog] = useState(false);
  const [selectedIP, setSelectedIP] = useState<string | null>(null);

  const directiveOptions = useMemo(
    () => Object.entries(directives).sort((a, b) => a[0].localeCompare(b[0])),
    [directives],
  );

  const showError = (msg: string) => {
    setErr(msg);
    setShowErrorModal(true);
    turnstileRef.current?.reset();
  };

  useEffect(() => {
    (async () => {
      try {
        const cfg = await getConfig();
        setSitekey(cfg.turnstile_sitekey);
        const [a, d] = await Promise.all([getAgents(), getDirectives()]);
        const sortedAgents = [...a.agents].sort((x, y) =>
          (x.display_name ?? x.agent_id).localeCompare(
            y.display_name ?? y.agent_id,
          ),
        );
        setAgents(sortedAgents);
        setDirectives(d.directives);
        setAgentId(sortedAgents[0]?.agent_id ?? "");
        setDirectiveId(Object.keys(d.directives)[0] ?? "");
        setLoading(false);
      } catch (e: any) {
        showError(String(e?.message ?? e));
        setLoading(false);
      }
    })();
  }, []);

  async function resolveTarget(input: string): Promise<string | null> {
    if (isIPAddress(input)) {
      return input;
    }

    setResolving(true);
    try {
      const directive = directives[directiveId];
      const family = detectAddressFamily(
        directiveId,
        directive?.field?.description,
      );

      let v4: string[] = [];
      let v6: string[] = [];

      if (family === "v4") {
        v4 = await resolveDNS(input, "A");
      } else if (family === "v6") {
        v6 = await resolveDNS(input, "AAAA");
      } else {
        const result = await resolveBoth(input);
        v4 = result.v4;
        v6 = result.v6;
      }

      const allIPs = [...v4, ...v6];
      if (allIPs.length === 0) {
        showError(`No DNS records found for ${input}`);
        return null;
      }

      if (allIPs.length === 1) {
        return allIPs[0];
      }

      setResolvedIPs({ hostname: input, v4, v6 });
      setShowIPDialog(true);
      return null;
    } catch (e: any) {
      showError(`DNS resolution failed: ${e?.message ?? e}`);
      return null;
    } finally {
      setResolving(false);
    }
  }

  function executeWithTarget(resolvedTarget: string) {
    setErr(null);
    setChunks([]);
    setJobId("");
    setRunning(true);

    const ws = new WebSocket(
      `${wsUrl("/ws/query")}?turnstile=${encodeURIComponent(turnstileToken)}`,
    );

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "start",
          agent_id: agentId,
          directive: directiveId,
          target: resolvedTarget,
        }),
      );
      setTurnstileToken("");
    };

    ws.onmessage = (evt) => {
      let msg: any;
      try {
        msg = JSON.parse(String(evt.data));
      } catch {
        return;
      }

      if (msg.type === "hello") {
        setJobId(msg.job ?? "");
        return;
      }

      if (msg.type === "chunk") {
        const seq = typeof msg.seq === "number" ? msg.seq : 0;
        const data = String(msg.data ?? "");
        setChunks((prev) => binaryInsertChunk(prev, { seq, data }));
        return;
      }

      if (msg.type === "stalled") {
        setChunks((prev) =>
          binaryInsertChunk(prev, {
            seq: Number.MAX_SAFE_INTEGER - 1,
            data: "\n[stalled]\n",
          }),
        );
        return;
      }

      if (msg.type === "exit") {
        setChunks((prev) =>
          binaryInsertChunk(prev, {
            seq: Number.MAX_SAFE_INTEGER,
            data: `\n[exit ${msg.code ?? 0}]\n`,
          }),
        );
        return;
      }

      if (msg.type === "error") {
        showError(String(msg.error ?? "error"));
        return;
      }
    };

    ws.onerror = () => {
      showError("websocket error");
      setRunning(false);
    };

    ws.onclose = () => {
      setRunning(false);
      turnstileRef.current?.reset();
    };
  }

  async function run() {
    if (!agentId || !directiveId || !target) {
      showError("agent, directive, and target are required");
      return;
    }

    const resolved = await resolveTarget(target.trim());
    if (resolved) {
      executeWithTarget(resolved);
    }
  }

  function handleIPSelect(ip: string) {
    setShowIPDialog(false);
    setResolvedIPs(null);
    setSelectedIP(ip);
    executeWithTarget(ip);
  }

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Looking Glass</h1>
          <div className="text-xs text-muted-foreground">
            {jobId ? `job: ${jobId}` : ""}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Request</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Router</div>
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select router" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.agent_id} value={a.agent_id}>
                        {a.display_name ?? a.agent_id}
                        {a.status === "offline" && (
                          <> — offline ({fmtAge(a.age_ms)})</>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  Directive
                </div>
                <Select value={directiveId} onValueChange={setDirectiveId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select directive" />
                  </SelectTrigger>
                  <SelectContent>
                    {directiveOptions.map(([id, d]) => (
                      <SelectItem key={id} value={id}>
                        {id} — {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  Target (hostname or IP)
                </div>
                <Input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="example.com or 203.0.113.1"
                />
              </div>
            </div>

            <div className="mt-4 flex flex-col md:flex-row md:items-end gap-3">
              <div className="flex-1">
                <div className="text-xs text-muted-foreground mb-1">
                  Turnstile (required per request)
                </div>
                {sitekey ? (
                  <TurnstileBox
                    ref={turnstileRef}
                    sitekey={sitekey}
                    onToken={setTurnstileToken}
                  />
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={running || resolving || !turnstileToken}
                  onClick={run}
                >
                  {resolving ? "Resolving…" : running ? "Running…" : "Run"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Output</CardTitle>
          </CardHeader>
          <CardContent>
            <pre
              className="text-xs rounded-md p-3 min-h-[320px] ansi-output"
              style={{ backgroundColor: "#F3F3F3", color: "#3e3e3e" }}
            >
              {chunks.length > 0 ? (
                <Anser useClasses>{chunks.map((c) => c.data).join("")}</Anser>
              ) : (
                "(no output yet)"
              )}
            </pre>
          </CardContent>
        </Card>

        <div className="text-xs text-muted-foreground">
          Notes: domain names are resolved via Cloudflare DoH. IPv4/IPv6 targets
          are also accepted. Output is streamed over WebSockets.
        </div>
      </div>

      <Dialog open={showIPDialog} onOpenChange={setShowIPDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select IP Address</DialogTitle>
            <DialogDescription>
              Multiple addresses found for {resolvedIPs?.hostname}. Select one:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {resolvedIPs?.v4.map((ip) => (
              <Button
                key={ip}
                variant="outline"
                className="w-full justify-start"
                onClick={() => handleIPSelect(ip)}
              >
                <span className="text-muted-foreground mr-2">IPv4</span>
                {ip}
              </Button>
            ))}
            {resolvedIPs?.v6.map((ip) => (
              <Button
                key={ip}
                variant="outline"
                className="w-full justify-start"
                onClick={() => handleIPSelect(ip)}
              >
                <span className="text-muted-foreground mr-2">IPv6</span>
                {ip}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowIPDialog(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showErrorModal} onOpenChange={setShowErrorModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription className="text-destructive">
              {err}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setShowErrorModal(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
