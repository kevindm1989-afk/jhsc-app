/**
 * Shared CORS surface for the browser-facing, verify_jwt=false Edge Functions
 * (mint-session, bootstrap-first-co-chair).
 *
 * Why this exists: the SvelteKit SPA is served from the Cloudflare Pages origin
 * (e.g. https://jhsc-app.pages.dev) and posts to the Supabase Functions origin
 * (https://<project>.supabase.co). That is a cross-origin request with custom
 * headers (`apikey`, `content-type`), so the browser issues a CORS preflight
 * (OPTIONS) and requires `Access-Control-Allow-Origin` on every response. The
 * Supabase edge runtime does NOT add these automatically — the function must.
 *
 * Origin authority: the allowed-origin set is `MINT_EXPECTED_ORIGINS` — the
 * SAME allowlist the handlers already use to gate the WebAuthn ceremony (F-37).
 * We reflect the request `Origin` ONLY when it is a member (or when no
 * allowlist is configured — local/dev). A non-allowlisted origin gets no
 * `Access-Control-Allow-Origin`, so the browser blocks it: defense in depth
 * that mirrors the handler-level origin check, not a replacement for it.
 *
 * This is transport plumbing only: it changes NO trust decision. The handler
 * still independently validates origin, consumes the single-use challenge, and
 * verifies the attestation/assertion server-side.
 */

// Headers the browser clients send: the raw fetch in the bootstrap page sends
// `content-type` + `apikey`; the supabase-js mint-session client additionally
// sends `authorization` + `x-client-info`. `x-request-id` is the log-correlation
// header. List them all so the preflight never rejects a legitimate call.
const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type, x-request-id';
const ALLOW_METHODS = 'POST, OPTIONS';

function allowedOrigins(): string[] {
  return (Deno.env.get('MINT_EXPECTED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The CORS response headers for this request. `Access-Control-Allow-Origin` is
 * present only when the request Origin is allowlisted (or no allowlist is set).
 * Always `Vary: Origin` so caches never serve one origin's ACAO to another.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = allowedOrigins();
  const allowOrigin = allow.length === 0 ? origin : allow.includes(origin) ? origin : '';

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
  return headers;
}

/**
 * Drop-in replacement for `Deno.serve` that adds the CORS surface for the
 * browser-facing ops: it answers the `OPTIONS` preflight directly (204, no
 * side effects) and appends the CORS headers to every real response so the
 * browser can read it. Call sites change only `Deno.serve(` → `serveWithCors(`;
 * the wrapped handler keeps its existing body and trust decisions verbatim.
 *
 * (mint-session and bootstrap-first-co-chair use the equivalent inline form
 * introduced in their own dispatchers; this helper is the shared form used by
 * the JWT-bound feature ops.)
 */
export function serveWithCors(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    const res = await handler(req);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  });
}
