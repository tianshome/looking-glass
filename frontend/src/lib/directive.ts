export type AddressFamily = "v4" | "v6" | "both";

export function detectAddressFamily(
  directiveId: string,
  description?: string,
): AddressFamily {
  const idLower = directiveId.toLowerCase();
  const descLower = (description ?? "").toLowerCase();

  if (/_v4\b/.test(idLower) || /\bv4\b/.test(idLower)) return "v4";
  if (/_v6\b/.test(idLower) || /\bv6\b/.test(idLower)) return "v6";

  const hasV4 = descLower.includes("ipv4") || descLower.includes("ip v4");
  const hasV6 = descLower.includes("ipv6") || descLower.includes("ip v6");

  if (hasV4 && !hasV6) return "v4";
  if (hasV6 && !hasV4) return "v6";

  return "both";
}
