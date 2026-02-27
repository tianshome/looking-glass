# Distributed Looking Glass (Cloudflare Worker + Go Agents)

Public network looking glass with a **distributed** execution model:

- **Cloudflare Worker** serves the **frontend** and exposes the public API.
- **Go agent** runs on each router (Ubuntu Linux amd64) and executes commands locally.
- **Streaming** output is relayed agent → Worker/DO → browser via WebSockets.

## Key constraints (as implemented)

- `directives.yml` and `directives.yml.sig` are **bundled with the Worker** (single source of truth).
- Agents **periodically fetch** `directives.yml` + `.sig` from the Worker (separate from heartbeat).
- Agent verifies signature using `ssh-keygen` and an **ssh-ed25519** public key passed as a CLI **string**.
- No user authentication (public LG). Turnstile is required for each query request.
- Rate limiting is enforced at the Worker edge (Workers Rate Limiting API) **(stubbed; see progress.txt)**.
- Audit logging: **request only** (start + completion update) written to **Cloudflare D1**.
- Durable Objects coordinate multi-region WebSockets and broadcast to all connected clients.

## Repository layout

- `worker/` — Cloudflare Worker + Durable Objects + D1 schema
- `frontend/` — React + TypeScript UI (shadcn-style components)
- `agent/` — Go agent
- `docs/` — design docs (AGENTS.md, TECH_STACK.md, IMPLEMENTATION_PLAN.md)
- `scripts/` — signing helper for `directives.yml`

## Quick start (local dev notes)

This repo is designed for Cloudflare deployment; local dev requires Node tooling and wrangler.

1. Copy env example:

```bash
cp example.env .dev.vars
```

2. Install deps:

```bash
pnpm install
```

3. Build frontend:

```bash
pnpm -C frontend build
```

4. Run worker locally:

```bash
pnpm -C worker dev
```

5. Run agent:

```bash
cd agent
go build -o ../build/lg-agent ./cmd/lg-agent
./lg-agent \
  -worker-url http://127.0.0.1:8787 \
  -agent-id rt1 \
  -display-name "🌏 Router 1" \
  -secret "$AGENT_SHARED_SECRET" \
  -pubkey "$DIRECTIVES_SIGNING_PUBKEY"
```

See `docs/AGENTS.md` for agent protocol and signing details.

## Deploying

1. Generate a signing key for directives:

```bash
mkdir -p keys
ssh-keygen -t ed25519 -f keys/lg_directives_ed25519 -N "" -C "lg-directives"
```

2. Sign directives.yml:

```bash
./scripts/sign_directives.sh keys/lg_directives_ed25519
```

3. Set up production D1 database (first time only):

```bash
pnpm -C worker exec wrangler d1 create lg_logs
# Note the database_id (UUID) from the output
```

4. Configure production wrangler:

```bash
cp worker/wrangler.prod.toml.example worker/wrangler.prod.toml
# Edit worker/wrangler.prod.toml and fill in:
# - AGENT_SHARED_SECRET (generate with: openssl rand -base64 32)
# - TURNSTILE_SITEKEY and TURNSTILE_SECRET (from Cloudflare Turnstile dashboard)
# - database_id (UUID from previous step)
```

5. Deploy:

```bash
# Initialize SQL DB
pnpm -C worker exec wrangler d1 --config wrangler.prod.toml execute lg_logs --remote --file=schema.sql

# Deploy to custom domain
pnpm -C worker exec wrangler deploy --config wrangler.prod.toml --domains lg.example.net
```
