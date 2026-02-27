export type AgentInfo = {
  agent_id: string;
  first_seen: number;
  last_seen: number;
  version?: string;
  directives_hash?: string;
  display_name?: string;
  status: "online" | "offline";
  age_ms: number;
};

export type DirectivesResponse = {
  directives: Record<
    string,
    {
      name: string;
      rules: Array<any>;
      field: { type?: string; description?: string };
    }
  >;
};

export async function getConfig(): Promise<{ turnstile_sitekey: string }> {
  const r = await fetch("/api/config");
  if (!r.ok) throw new Error(`config fetch failed: ${r.status}`);
  return await r.json();
}

export async function getAgents(): Promise<{ agents: AgentInfo[] }> {
  const r = await fetch("/api/agents");
  if (!r.ok) throw new Error(`agents fetch failed: ${r.status}`);
  return await r.json();
}

export async function getDirectives(): Promise<DirectivesResponse> {
  const r = await fetch("/api/directives");
  if (!r.ok) throw new Error(`directives fetch failed: ${r.status}`);
  const j = await r.json();
  return j;
}
