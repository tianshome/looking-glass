/**
 * Workers Rate Limiting API integration point.
 *
 * The exact binding/API depends on Cloudflare feature configuration.
 * This repo intentionally ships a stub to avoid prescribing the wrong interface.
 */

export async function enforceRateLimit(_env: any, _key: string): Promise<{ allowed: boolean; reason?: string }> {
  // TODO: integrate Cloudflare Workers Rate Limiting API (RateLimit).
  // Example shapes seen in some environments include:
  //   await env.RATELIMIT.limit({ key })
  // or using a "rate_limit" binding with a .limit() method.
  return { allowed: true };
}
