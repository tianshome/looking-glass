# Implementation Plan

## 1. Worker + Durable Objects
1) Bundle config directly into Worker code:
- `directives.yml` and `directives.yml.sig`
- offline/hidden thresholds
- stall timeout

2) Implement HTTP endpoints:
- `GET /directives.yml` and `GET /directives.yml.sig`
- `GET /api/directives` → parsed JSON for UI
- `GET /api/agents` → presence enumeration from D1 `agent_presence` (filtered by thresholds)

3) Implement WebSocket endpoints:
- `/ws/agent/<agent-id>` → routed to per-agent AgentDirectoryDO instance
- `/ws/query` → Turnstile verify + rate limit + routed to QuerySessionDO

4) AgentDirectoryDO
- Accept agent WS
- Handle `register` and `heartbeat`
- Track `first_seen` and `last_seen`
- Route agent events (`chunk`, `keepalive`, `exit`) to the matching QuerySessionDO

5) QuerySessionDO
- Accept client WS, broadcast to all client sockets for that job
- On `start` message: validate target is IPv4/v6, validate directive exists, insert audit log row
- Send exec to AgentDirectoryDO
- Stall watchdog: if no `chunk`/`keepalive` within `STALL_TIMEOUT_MS`, cancel job and notify clients
- On exit: update audit record, close clients

6) D1 audit logging
- Single request record per job:
  - insert on start
  - update on completion

## 2. Frontend
1) Fetch agent list and directives list from Worker.
2) Require Turnstile token for each query.
3) Open WS to `/ws/query?turnstile=<token>` and send `start` message.
4) Stream output into terminal-like UI.

## 3. Agent
1) Periodic directives fetch:
- GET `/directives.yml` and `/directives.yml.sig`
- verify signature with `ssh-keygen`
- parse directives into memory

2) Outbound agent WS:
- register with secret
- heartbeat periodically

3) Exec:
- validate target is IPv4/v6
- resolve directive to argv
- execute without shell
- stream stdout/stderr chunks
- send periodic keepalive frames

## 4. Hardening (explicitly out of scope here)
- Per-agent unique secrets or stronger authentication
- Additional safety boundaries for potentially abusable commands
