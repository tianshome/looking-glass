const DOH_URL = "https://cloudflare-dns.com/dns-query";

type DNSRecordType = "A" | "AAAA";

interface DNSAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DNSResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Question?: Array<{ name: string; type: number }>;
  Answer?: DNSAnswer[];
}

export async function resolveDNS(
  hostname: string,
  type: DNSRecordType,
): Promise<string[]> {
  const url = `${DOH_URL}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const res = await fetch(url, {
    headers: { Accept: "application/dns-json" },
  });
  if (!res.ok) {
    throw new Error(`DNS query failed: ${res.status}`);
  }
  const data: DNSResponse = await res.json();
  if (data.Status !== 0) {
    return [];
  }
  return (data.Answer ?? [])
    .map((a) => a.data)
    .filter((ip) => ip && !ip.endsWith("."));
}

export async function resolveBoth(hostname: string): Promise<{
  v4: string[];
  v6: string[];
}> {
  const [v4, v6] = await Promise.all([
    resolveDNS(hostname, "A"),
    resolveDNS(hostname, "AAAA"),
  ]);
  return { v4, v6 };
}
