/**
 * client-ip.ts — extract the client IP from the trusted edge-runtime headers.
 *
 * Why this exists: the `redeem-invite` EF is permanently internet-reachable and
 * UNAUTHENTICATED (the invitee has no JWT). F-175 requires a per-IP throttle
 * applied BEFORE the DB round-trip so a code-less flood can never reach the
 * `redeem_invite_complete` RPC nor mutate the TOTP lock counter. To throttle by
 * IP we need a stable, edge-trusted IP. We MUST NOT trust the FIRST hop of a
 * raw `X-Forwarded-For` blindly (any client can prepend it); we read the
 * left-most "client" leaf only from headers the Supabase edge runtime itself
 * has populated.
 *
 * Trust ordering (most → least specific; the FIRST present wins):
 *   1. `CF-Connecting-IP` — Cloudflare's single-value origin client IP. When
 *      Supabase deploys behind Cloudflare this is the leaf, set by Cloudflare
 *      AFTER stripping client-supplied versions of the same header.
 *   2. `X-Real-IP` — single-value origin IP set by the reverse proxy.
 *   3. `Fly-Client-IP` — Fly.io edge equivalent (Supabase Functions runs on
 *      Fly for some regions); single-value, set by the platform.
 *   4. `X-Forwarded-For` LEFT-MOST entry — the conventional client IP.
 *      We split on `,` and trim; the LEFT-most is the originating client.
 *      This is the weakest input (clients can prepend), but it is the standard
 *      and the only fallback for edge environments where (1)–(3) are absent.
 *
 * If none of the above are present we return `null`. The throttle layer
 * treats a `null` IP as a single shared bucket — so a misconfigured edge
 * cannot accidentally OPEN the rate-limit (the floor is conservative).
 *
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is normalised to the IPv4 form so a
 * dual-stack client cannot escape the IPv4 bucket by riding the IPv6 path.
 *
 * F-176: the extracted IP is a low-resolution network identifier, never logged
 * with a value — only the bucket-class label (`rate_limit_key_class`) is
 * emitted. The IP itself stays in memory for the throttle keyspace.
 */

export interface ClientIpExtractor {
  (req: Request): string | null;
}

const HEADER_PRIORITY = [
  'cf-connecting-ip',
  'x-real-ip',
  'fly-client-ip',
] as const;

function normalizeIp(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip an IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`).
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return m ? m[1] : trimmed;
}

/**
 * Pull a single client IP from the trusted edge-runtime headers, falling back
 * to the LEFT-most `X-Forwarded-For` leaf. Returns `null` when nothing is
 * present (the throttle layer collapses that into a single shared bucket).
 */
export function extractClientIp(req: Request): string | null {
  for (const name of HEADER_PRIORITY) {
    const v = req.headers.get(name);
    if (v) {
      const n = normalizeIp(v);
      if (n) return n;
    }
  }
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    // Conventional left-most entry.
    const leftMost = xff.split(',')[0];
    if (leftMost) {
      const n = normalizeIp(leftMost);
      if (n) return n;
    }
  }
  return null;
}
