# Tech Stack

## Cloudflare Worker (TypeScript)
- Cloudflare Workers runtime (module worker)
- Durable Objects:
  - `AgentDirectoryDO`: per-agent WebSocket session + routing to query DOs
  - `QuerySessionDO`: per-request WebSocket session + broadcast + stall watchdog
- Cloudflare D1 (SQLite) for audit logging and agent presence
- Turnstile verification (server-side `siteverify`)
- Workers Rate Limiting API (planned; currently stubbed)

## Frontend (TypeScript)
- React + Vite
- Tailwind CSS
- shadcn-style UI components (minimal subset included)
- WebSocket streaming client
- Cloudflare Turnstile widget integration (explicit render)

## Agent (Go)
- Ubuntu Linux amd64 target
- WebSocket client (`nhooyr.io/websocket`)
- YAML parsing (`gopkg.in/yaml.v3`)
- Signature verification via `ssh-keygen -Y verify`
- Command execution via `exec.Command` (no shell)
- Streaming stdout/stderr + periodic keepalive frames
