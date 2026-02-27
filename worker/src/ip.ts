export function isIPv4(s: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return false;
  const parts = s.split(".");
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function isHexGroup(g: string): boolean {
  return /^[0-9a-fA-F]{1,4}$/.test(g);
}

export function isIPv6(s: string): boolean {
  // Conservative IPv6 validator supporting :: compression and v4-embedded.
  if (/[\s]/.test(s)) return false;
  if (s.length < 2) return false;

  const hasDouble = s.includes("::");
  if (hasDouble && s.indexOf("::") !== s.lastIndexOf("::")) return false;

  const [head, tail] = hasDouble ? s.split("::") : [s, ""];
  const headParts = head ? head.split(":").filter((x) => x.length > 0) : [];
  const tailParts = tail ? tail.split(":").filter((x) => x.length > 0) : [];

  const parts = [...headParts, ...tailParts];

  // embedded IPv4 in last group
  let embeddedV4 = false;
  if (parts.length > 0 && parts[parts.length - 1].includes(".")) {
    embeddedV4 = true;
    const last = parts.pop() as string;
    if (!isIPv4(last)) return false;
  }

  if (!parts.every(isHexGroup)) return false;

  const groupCount = parts.length;
  const maxGroups = embeddedV4 ? 6 : 8;

  if (hasDouble) {
    return groupCount <= maxGroups;
  }
  return groupCount === maxGroups;
}

export function isIP(s: string): boolean {
  if (/[\s]/.test(s)) return false;
  return isIPv4(s) || isIPv6(s);
}
