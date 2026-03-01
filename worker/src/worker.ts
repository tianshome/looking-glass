import { DIRECTIVES_SIG, DIRECTIVES_YAML } from "./bundled";
import { parseDirectivesYaml } from "./directives";
import { isIP } from "./ip";
import { enforceRateLimit } from "./ratelimit";
import { verifyTurnstile } from "./turnstile";

export interface Env {
  ASSETS?: Fetcher;
  AGENT_SHARED_SECRET: string;
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET: string;
  OFFLINE_AFTER_MS: string;
  HIDDEN_AFTER_MS: string;
  STALL_TIMEOUT_MS: string;
  MAX_CMD_RUNTIME_MS: string;
  RATE_LIMIT_ENABLED: string;

  DB: D1Database;
  AGENTS: DurableObjectNamespace;
  QUERIES: DurableObjectNamespace;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

type AgentPresenceRow = {
  agent_id: string;
  first_seen: number;
  last_seen: number;
  version: string | null;
  directives_hash: string | null;
  display_name: string | null;
  connected: number;
};

const AGENT_WS_PREFIX = "/ws/agent/";
let presenceSchemaReady: Promise<void> | undefined;

function parseAgentIdFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(AGENT_WS_PREFIX)) return undefined;
  const raw = pathname.slice(AGENT_WS_PREFIX.length);
  if (!raw || raw.includes("/")) return undefined;
  try {
    const agentId = decodeURIComponent(raw);
    if (!agentId || /\s/.test(agentId)) return undefined;
    return agentId;
  } catch {
    return undefined;
  }
}

async function ensurePresenceSchema(env: Env): Promise<void> {
  if (!presenceSchemaReady) {
    presenceSchemaReady = (async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS agent_presence (agent_id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, version TEXT, directives_hash TEXT, display_name TEXT, connected INTEGER NOT NULL DEFAULT 0)",
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON agent_presence(last_seen)",
      ).run();
    })();
  }

  try {
    await presenceSchemaReady;
  } catch (err) {
    presenceSchemaReady = undefined;
    throw err;
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Serve directives and signature as static text.
    if (url.pathname === "/directives.yml") {
      return new Response(DIRECTIVES_YAML, {
        headers: { "content-type": "text/yaml; charset=utf-8" },
      });
    }
    if (url.pathname === "/directives.yml.sig") {
      return new Response(DIRECTIVES_SIG, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Small config endpoint for frontend.
    if (url.pathname === "/api/config") {
      return json({ turnstile_sitekey: env.TURNSTILE_SITEKEY });
    }

    if (url.pathname === "/api/directives") {
      const directives = parseDirectivesYaml(DIRECTIVES_YAML);
      return json({ directives });
    }

    if (url.pathname === "/api/agents") {
      await ensurePresenceSchema(env);
      const rows = await env.DB.prepare(
        "SELECT agent_id, first_seen, last_seen, version, directives_hash, display_name, connected FROM agent_presence ORDER BY agent_id ASC",
      ).all<AgentPresenceRow>();
      const agents = rows.results ?? [];

      const now = Date.now();
      const offlineAfter = Number(env.OFFLINE_AFTER_MS);
      const hiddenAfter = Number(env.HIDDEN_AFTER_MS);

      const filtered = agents
        .map((a) => {
          const ageMs = now - a.last_seen;
          const connected = Number(a.connected ?? 0) === 1;
          const status =
            connected && ageMs <= offlineAfter ? "online" : "offline";
          const hidden = ageMs > hiddenAfter;
          return {
            agent_id: a.agent_id,
            first_seen: a.first_seen,
            last_seen: a.last_seen,
            version: a.version ?? undefined,
            directives_hash: a.directives_hash ?? undefined,
            display_name: a.display_name ?? undefined,
            connected,
            status,
            hidden,
            age_ms: ageMs,
          };
        })
        .filter((a) => !a.hidden);

      return json({
        agents: filtered,
        offline_after_ms: offlineAfter,
        hidden_after_ms: hiddenAfter,
      });
    }

    // WebSocket: agent -> per-agent DO
    if (url.pathname === "/ws/agent") {
      return json(
        { error: "agent id required: /ws/agent/<agent_id>" },
        { status: 400 },
      );
    }
    if (url.pathname.startsWith(AGENT_WS_PREFIX)) {
      const agentId = parseAgentIdFromPath(url.pathname);
      if (!agentId)
        return json({ error: "invalid agent id in path" }, { status: 400 });

      const doId = env.AGENTS.idFromName(agentId);
      const stub = env.AGENTS.get(doId);
      const headers = new Headers(request.headers);
      headers.set("X-Agent-Id", agentId);

      return stub.fetch(
        new Request("https://agents/ws/agent", {
          method: request.method,
          headers,
          body: request.body,
          // @ts-expect-error duplex required for streaming bodies in some runtimes; harmless here.
          duplex: "half",
        }),
      );
    }

    // WebSocket: client query → QuerySessionDO
    if (url.pathname === "/ws/query") {
      // Turnstile required for each request (each query WS connection).
      const token = url.searchParams.get("turnstile");
      if (!token)
        return json({ error: "missing turnstile token" }, { status: 400 });

      const clientIp = request.headers.get("CF-Connecting-IP") ?? undefined;
      const v = await verifyTurnstile(env.TURNSTILE_SECRET, token, clientIp);
      if (!v.success) {
        return json(
          { error: "turnstile verification failed", codes: v.errorCodes ?? [] },
          { status: 403 },
        );
      }

      // Worker-side rate limit (stubbed).
      if (String(env.RATE_LIMIT_ENABLED).toLowerCase() === "true") {
        const key = clientIp ?? "unknown";
        const r = await enforceRateLimit(env, key);
        if (!r.allowed)
          return json(
            { error: "rate limited", reason: r.reason },
            { status: 429 },
          );
      }

      // Create a per-request job id and forward the upgrade to a per-job DO instance.
      const jobId = crypto.randomUUID();
      const doId = env.QUERIES.idFromName(jobId);
      const stub = env.QUERIES.get(doId);

      const headers = new Headers(request.headers);
      headers.set("X-Job-Id", jobId);
      if (clientIp) headers.set("X-Client-Ip", clientIp);

      return stub.fetch(
        new Request("https://queries/ws/query", {
          method: request.method,
          headers,
          body: request.body,
          // @ts-expect-error duplex required for streaming bodies in some runtimes; harmless here.
          duplex: "half",
        }),
      );
    }

    // Fallback to static asset serving (wrangler [assets]).
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

// ---------------- Durable Objects ----------------

type AgentSocketAttachment = {
  agent_id: string;
  registered: boolean;
  version?: string;
  directives_hash?: string;
  display_name?: string;
};

export class AgentDirectoryDO {
  private state: DurableObjectState;
  private env: Env;
  private readonly presenceReady: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.presenceReady = ensurePresenceSchema(env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws/agent") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const reqAgentId = request.headers.get("X-Agent-Id") ?? "";
      if (!reqAgentId)
        return new Response("missing X-Agent-Id header", { status: 400 });
      this.state.acceptWebSocket(server);
      this.setSocketAttachment(server, {
        agent_id: reqAgentId,
        registered: false,
      });

      server.send(JSON.stringify({ type: "hello" }));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/send") {
      const body = (await request.json()) as any;
      const msg = body.msg;
      const ws = this.getRegisteredSocket();
      if (!ws)
        return json(
          { ok: false, error: "agent not connected" },
          { status: 404 },
        );
      try {
        ws.send(JSON.stringify(msg));
        return json({ ok: true });
      } catch {
        const att = this.getSocketAttachment(ws);
        if (att?.registered) void this.markOffline(att.agent_id);
        try {
          ws.close(1011, "send failed");
        } catch {
          // ignore
        }
        return json({ ok: false, error: "send failed" }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    await this.onMessage(ws, text);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = this.getSocketAttachment(ws);
    if (att?.registered) await this.markOffline(att.agent_id);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const att = this.getSocketAttachment(ws);
    if (att?.registered) await this.markOffline(att.agent_id);
  }

  private async onMessage(ws: WebSocket, text: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid json" }));
      return;
    }

    const socketAtt = this.getSocketAttachment(ws);
    if (!socketAtt) {
      ws.close(1008, "socket metadata missing");
      return;
    }

    const now = Date.now();

    if (msg.type === "register") {
      const agentId = String(msg.agent_id ?? "");
      const secret = String(msg.secret ?? "");
      if (!agentId) {
        ws.send(JSON.stringify({ type: "error", error: "missing agent_id" }));
        return;
      }
      if (agentId !== socketAtt.agent_id) {
        ws.send(
          JSON.stringify({ type: "error", error: "agent_id path mismatch" }),
        );
        ws.close(1008, "invalid agent id");
        return;
      }
      if (secret !== this.env.AGENT_SHARED_SECRET) {
        ws.send(JSON.stringify({ type: "error", error: "invalid secret" }));
        ws.close(1008, "unauthorized");
        return;
      }

      // Bind ws to agent id (last registration wins).
      const existing = this.getRegisteredSocket();
      if (existing && existing !== ws) {
        const existingAtt = this.getSocketAttachment(existing);
        if (existingAtt)
          this.setSocketAttachment(existing, {
            ...existingAtt,
            registered: false,
          });
        try {
          existing.close(1012, "replaced");
        } catch {
          // ignore
        }
      }

      const version = msg.version ? String(msg.version) : socketAtt.version;
      const directivesHash = msg.directives_hash
        ? String(msg.directives_hash)
        : socketAtt.directives_hash;
      const displayName =
        msg.display_name !== undefined
          ? String(msg.display_name)
          : socketAtt.display_name;
      this.setSocketAttachment(ws, {
        agent_id: socketAtt.agent_id,
        registered: true,
        version,
        directives_hash: directivesHash,
        display_name: displayName,
      });

      await this.markOnline(
        now,
        socketAtt.agent_id,
        version,
        directivesHash,
        displayName,
      );

      ws.send(JSON.stringify({ type: "registered", agent_id: agentId }));
      return;
    }

    if (msg.type === "heartbeat") {
      if (!socketAtt.registered) return;
      const directivesHash = msg.directives_hash
        ? String(msg.directives_hash)
        : socketAtt.directives_hash;
      this.setSocketAttachment(ws, {
        agent_id: socketAtt.agent_id,
        registered: true,
        version: socketAtt.version,
        directives_hash: directivesHash,
        display_name: socketAtt.display_name,
      });
      await this.markOnline(
        now,
        socketAtt.agent_id,
        socketAtt.version,
        directivesHash,
        socketAtt.display_name,
      );
      return;
    }

    // Agent events that must be routed to QuerySessionDO.
    if (
      msg.type === "chunk" ||
      msg.type === "keepalive" ||
      msg.type === "exit"
    ) {
      if (!socketAtt.registered) return;
      await this.markOnline(
        now,
        socketAtt.agent_id,
        socketAtt.version,
        socketAtt.directives_hash,
        socketAtt.display_name,
      );

      const job = String(msg.job ?? "");
      if (!job) return;
      const stub = this.env.QUERIES.get(this.env.QUERIES.idFromName(job));
      await stub.fetch("https://queries/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg),
      });
      return;
    }

    // Unknown messages are ignored.
  }

  private getRegisteredSocket(): WebSocket | undefined {
    for (const ws of this.state.getWebSockets()) {
      const att = this.getSocketAttachment(ws);
      if (att?.registered) return ws;
    }
    return undefined;
  }

  private getSocketAttachment(
    ws: WebSocket,
  ): AgentSocketAttachment | undefined {
    const raw = ws.deserializeAttachment();
    if (!raw || typeof raw !== "object") return undefined;
    const row = raw as Record<string, unknown>;
    const agentId = typeof row.agent_id === "string" ? row.agent_id : "";
    if (!agentId) return undefined;
    return {
      agent_id: agentId,
      registered: row.registered === true,
      version: typeof row.version === "string" ? row.version : undefined,
      directives_hash:
        typeof row.directives_hash === "string"
          ? row.directives_hash
          : undefined,
      display_name:
        typeof row.display_name === "string" ? row.display_name : undefined,
    };
  }

  private setSocketAttachment(ws: WebSocket, att: AgentSocketAttachment): void {
    ws.serializeAttachment(att);
  }

  private async markOnline(
    now: number,
    agentId: string,
    version: string | undefined,
    directivesHash: string | undefined,
    displayName: string | undefined,
  ): Promise<void> {
    if (!agentId) return;
    await this.presenceReady;

    await this.env.DB.prepare(
      `INSERT INTO agent_presence (agent_id, first_seen, last_seen, version, directives_hash, display_name, connected)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(agent_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         version = COALESCE(excluded.version, agent_presence.version),
         directives_hash = COALESCE(excluded.directives_hash, agent_presence.directives_hash),
         display_name = COALESCE(excluded.display_name, agent_presence.display_name),
         connected = 1`,
    )
      .bind(
        agentId,
        now,
        now,
        version ?? null,
        directivesHash ?? null,
        displayName ?? null,
      )
      .run();
  }

  private async markOffline(agentId: string): Promise<void> {
    if (!agentId) return;
    await this.presenceReady;

    const current = this.getRegisteredSocket();
    const currentAtt = current ? this.getSocketAttachment(current) : undefined;
    if (currentAtt?.agent_id === agentId && currentAtt.registered) {
      return;
    }

    await this.env.DB.prepare(
      "UPDATE agent_presence SET connected = 0, last_seen = ? WHERE agent_id = ?",
    )
      .bind(Date.now(), agentId)
      .run();
  }
}

// SQLite-backed class bound in wrangler migrations/bindings.
export class AgentDirectorySQLiteDO extends AgentDirectoryDO {}

// --- Query session DO ---

type StartMsg = {
  type: "start";
  agent_id: string;
  directive: string;
  target: string;
};

type QueryState = {
  job_id: string;
  started: boolean;
  agent_id?: string;
  directive?: string;
  target?: string;
  last_event_at: number;
  stalled: boolean;
  exit_received: boolean;
  exit_code?: number;
  close_scheduled: boolean;
};

export class QuerySessionDO {
  private state: DurableObjectState;
  private env: Env;

  private clients = new Set<WebSocket>();
  private q: QueryState;
  private stallTimer: number | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.q = {
      job_id: "",
      started: false,
      last_event_at: Date.now(),
      stalled: false,
      exit_received: false,
      close_scheduled: false,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Client websocket for this job
    if (url.pathname === "/ws/query") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const jobId = request.headers.get("X-Job-Id") ?? crypto.randomUUID();
      this.q.job_id = jobId;

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Use the standard WebSocket API because this class handles events via
      // addEventListener(). Durable Object hibernation sockets require
      // webSocketMessage/webSocketClose handlers instead.
      server.accept();

      this.clients.add(server);

      server.addEventListener("message", (evt) =>
        this.onClientMessage(server, evt, request),
      );
      server.addEventListener("close", () => this.onClientClose(server));
      server.addEventListener("error", () => this.onClientClose(server));

      server.send(JSON.stringify({ type: "hello", job: jobId }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Internal: routed agent event
    if (url.pathname === "/event" && request.method === "POST") {
      const msg = (await request.json()) as any;
      await this.onAgentEvent(msg);
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  private async onClientMessage(
    ws: WebSocket,
    evt: MessageEvent,
    req: Request,
  ): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid json" }));
      return;
    }

    if (msg.type !== "start") {
      ws.send(JSON.stringify({ type: "error", error: "expected start" }));
      return;
    }

    if (this.q.started) {
      ws.send(JSON.stringify({ type: "error", error: "already started" }));
      return;
    }

    const start = msg as StartMsg;
    if (!start.agent_id || !start.directive || !start.target) {
      ws.send(JSON.stringify({ type: "error", error: "missing fields" }));
      return;
    }

    if (!isIP(start.target)) {
      ws.send(
        JSON.stringify({ type: "error", error: "target must be ipv4/ipv6" }),
      );
      return;
    }

    const directives = parseDirectivesYaml(DIRECTIVES_YAML);
    const directive = directives[start.directive];
    if (!directive) {
      ws.send(JSON.stringify({ type: "error", error: "unknown directive" }));
      return;
    }

    this.q.started = true;
    this.q.agent_id = start.agent_id;
    this.q.directive = start.directive;
    this.q.target = start.target;

    // Write audit record (request only: insert at start; update on completion).
    const now = Date.now();
    const clientIp =
      req.headers.get("X-Client-Ip") ??
      req.headers.get("CF-Connecting-IP") ??
      null;
    const userAgent = req.headers.get("User-Agent") ?? null;

    await this.env.DB.prepare(
      "INSERT INTO audit_requests(job_id, created_at, agent_id, directive_id, target, client_ip, user_agent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        this.q.job_id,
        now,
        start.agent_id,
        start.directive,
        start.target,
        clientIp,
        userAgent,
        "started",
      )
      .run();

    // Request exec via per-agent DO
    const stub = this.env.AGENTS.get(
      this.env.AGENTS.idFromName(start.agent_id),
    );
    const timeoutMs = Number(this.env.MAX_CMD_RUNTIME_MS);

    const sendResp = await stub.fetch("https://agents/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        msg: {
          type: "exec",
          job: this.q.job_id,
          directive: start.directive,
          target: start.target,
          timeout_ms: timeoutMs,
        },
      }),
    });

    if (!sendResp.ok) {
      await this.fail(
        `agent not connected (${start.agent_id})`,
        "agent_offline",
      );
      ws.send(JSON.stringify({ type: "error", error: "agent offline" }));
      this.closeAll();
      return;
    }

    ws.send(JSON.stringify({ type: "started", job: this.q.job_id }));
    this.bumpStallTimer();
  }

  private async onAgentEvent(msg: any): Promise<void> {
    if (msg.type === "chunk" || msg.type === "keepalive") {
      this.q.last_event_at = Date.now();
      this.bumpStallTimer();
      this.broadcast(msg);
      if (this.q.exit_received) {
        this.scheduleClose();
      }
      return;
    }

    if (msg.type === "exit") {
      this.q.exit_received = true;
      this.q.exit_code = Number(msg.code ?? 0);
      this.broadcast(msg);
      await this.complete(this.q.exit_code);
      this.scheduleClose();
      return;
    }
  }

  private scheduleClose(): void {
    if (this.q.close_scheduled) return;
    this.q.close_scheduled = true;
    setTimeout(() => {
      this.closeAll();
    }, 500);
  }

  private broadcast(msg: any): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        ws.send(text);
      } catch {
        // ignore
      }
    }
  }

  private onClientClose(ws: WebSocket): void {
    this.clients.delete(ws);
    // If all clients disconnect, we keep the job alive; output will still be processed.
  }

  private bumpStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    const stallMs = Number(this.env.STALL_TIMEOUT_MS);

    this.stallTimer = setTimeout(() => void this.onStallTimeout(), stallMs);
  }

  private async onStallTimeout(): Promise<void> {
    if (!this.q.started || this.q.stalled) return;
    this.q.stalled = true;

    // Best-effort cancel
    if (this.q.agent_id) {
      const stub = this.env.AGENTS.get(
        this.env.AGENTS.idFromName(this.q.agent_id),
      );
      await stub.fetch("https://agents/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          msg: { type: "cancel", job: this.q.job_id },
        }),
      });
    }

    this.broadcast({ type: "stalled", job: this.q.job_id });
    await this.fail("stalled (no keepalive/output)", "stalled");
    this.closeAll();
  }

  private async complete(exitCode: number): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(
      "UPDATE audit_requests SET completed_at = ?, status = ?, exit_code = ? WHERE job_id = ?",
    )
      .bind(now, "complete", exitCode, this.q.job_id)
      .run();
  }

  private async fail(error: string, status: string): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(
      "UPDATE audit_requests SET completed_at = ?, status = ?, error = ? WHERE job_id = ?",
    )
      .bind(now, status, error, this.q.job_id)
      .run();
  }

  private closeAll(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = undefined;
    }
    for (const ws of this.clients) {
      try {
        ws.close(1000, "done");
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}

// SQLite-backed class bound in wrangler migrations/bindings.
export class QuerySessionSQLiteDO extends QuerySessionDO {}
