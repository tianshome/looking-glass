-- D1 schema for request-level audit logging

CREATE TABLE IF NOT EXISTS audit_requests (
  job_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,

  agent_id TEXT NOT NULL,
  directive_id TEXT NOT NULL,
  target TEXT NOT NULL,

  client_ip TEXT,
  user_agent TEXT,

  status TEXT NOT NULL,      -- started|complete|failed|stalled|agent_offline
  exit_code INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit_requests(agent_id);

CREATE TABLE IF NOT EXISTS agent_presence (
  agent_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  version TEXT,
  directives_hash TEXT,
  display_name TEXT,
  connected INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON agent_presence(last_seen);
