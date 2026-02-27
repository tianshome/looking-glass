# Agents

Each router runs the Go agent (`lg-agent`). Agents connect outbound to the Worker and:

- register with a shared secret
- heartbeat periodically (presence)
- fetch `directives.yml` and `directives.yml.sig` periodically (separate from heartbeat)
- verify `directives.yml.sig` with `ssh-keygen` using an `ssh-ed25519` public key provided via CLI string
- execute commands without a shell, streaming output back to the Worker

## Endpoints

- Agent WS: `wss://<worker-host>/ws/agent/<agent-id>`
- Directives fetch:
  - `https://<worker-host>/directives.yml`
  - `https://<worker-host>/directives.yml.sig`

## Registration + heartbeat protocol (JSON over WebSocket)

### Agent → Worker

- Register:

```json
{
  "type": "register",
  "agent_id": "rt1",
  "secret": "...",
  "version": "0.1.0",
  "directives_hash": "...",
  "display_name": "🌍 My Router"
}
```

The `display_name` field is optional and supports spaces and emojis. If provided, it will be displayed in the UI instead of the agent_id.

- Heartbeat:

```json
{ "type": "heartbeat", "agent_id": "rt1", "directives_hash": "..." }
```

### Worker → Agent

- Exec:

```json
{
  "type": "exec",
  "job": "<uuid>",
  "directive": "ping",
  "target": "203.0.113.1",
  "timeout_ms": 30000
}
```

- Cancel:

```json
{ "type": "cancel", "job": "<uuid>" }
```

### Agent → Worker (streaming)

- Output chunk:

```json
{
  "type": "chunk",
  "job": "<uuid>",
  "seq": 1,
  "stream": "stdout",
  "data": "..."
}
```

- Keepalive (sent periodically while command runs):

```json
{ "type": "keepalive", "job": "<uuid>", "ts": 1730000000 }
```

- Exit:

```json
{ "type": "exit", "job": "<uuid>", "code": 0 }
```

## `directives.yml` restrictions (to avoid shell)

This implementation expects directive commands to be represented as argv arrays.

Example:

```yaml
ping:
  name: Ping
  rules:
    - condition: ".*"
      action: permit
      command:
        argv: ["ping", "-c", "5", "{target}"]
  field:
    type: text
    description: "IPv4/IPv6"
```

Rules:

- Target must be IPv4 or IPv6 (no spaces).
- `{target}` substitution is supported inside argv entries.

## Signing format (ssh-keygen)

The agent verifies signatures using `ssh-keygen -Y verify`.

Recommended convention:

- principal/identity: `lg-directives`
- namespace: `lg-directives`

Signing (example):

```bash
ssh-keygen -Y sign -f ./keys/lg_directives_ed25519 -n lg-directives directives.yml
# produces directives.yml.sig
```

Verification (performed by agent):

- Agent creates an in-memory allowed signers file containing:
  `lg-directives <ssh-ed25519 public key>`
- Runs:

```bash
ssh-keygen -Y verify -f <allowed_signers> -I lg-directives -n lg-directives -s directives.yml.sig < directives.yml
```
