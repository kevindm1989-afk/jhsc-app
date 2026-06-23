/**
 * ADR-0029 P1-7 — /redeem production route mount (structural contract).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. Mirrors
 * sign-in-route-mount.test.ts: a file-read structural pin on the route shell
 * (route shells import `$app/stores`, which has no on-disk stub in this
 * runner, so they are pinned structurally, not rendered — the RENDERED
 * behavior lives in redeem-card.test.ts on the composed lib component).
 *
 * The route shell's load-bearing contract:
 *   - exists at apps/web/src/routes/redeem/+page.svelte
 *   - reads `invite_id` from the query string ($page.url.searchParams), NOT
 *     from a typed field (F-170: invite_id is the only thing in the URL)
 *   - composes the RedeemCard lib component, forwarding the inviteId
 *   - reads PUBLIC_SUPABASE_URL with a localhost:54321 fallback (mirror /sign-in)
 *   - targets the `redeem-invite` Edge Function (NOT bootstrap-first-co-chair,
 *     NOT mint-session)
 *   - prerender=true + ssr=false (no PI at mount; same posture as /sign-in)
 *   - noindex,nofollow meta (Surface J: the redeem page is not indexed)
 *   - resolves all visible strings via t() against redeem.* catalog keys
 *     (ADR-0009 / verify-i18n.sh)
 *   - carries NO `__test_*` prop (ADR-0020 Decision 8 production strip)
 *   - never appends the code/totp to a URL (F-170/F-176 structural guard)
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_DIR = resolve(__dirname, '../../src/routes/redeem');
const PAGE_PATH = resolve(ROUTE_DIR, '+page.svelte');
const PAGE_TS_PATH = resolve(ROUTE_DIR, '+page.ts');

function pageSrc(): string {
  return readFileSync(PAGE_PATH, 'utf8');
}

describe('P1-7 — /redeem route exists + composes RedeemCard', () => {
  it('the /redeem route exists at apps/web/src/routes/redeem/+page.svelte', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the route imports the RedeemCard lib component', () => {
    const src = pageSrc();
    expect(src).toMatch(
      /import\s+RedeemCard\s+from\s+['"][^'"]*lib\/redeem\/RedeemCard\.svelte['"]/
    );
  });

  it('the route reads invite_id from the query string ($page.url.searchParams)', () => {
    const src = pageSrc();
    // Mirrors the work-refusal / training / library / sensitive-feed routes'
    // query-param read pattern.
    expect(src).toMatch(/import\s*{[^}]*\bpage\b[^}]*}\s+from\s+['"]\$app\/stores['"]/);
    expect(src).toMatch(/\$page\.url\.searchParams\.get\(\s*['"]invite_id['"]\s*\)/);
  });

  it('the route forwards the read invite_id into RedeemCard as the inviteId prop', () => {
    const src = pageSrc();
    // Defense-in-depth: the card receives inviteId from the query read, NOT a
    // hardcoded literal.
    expect(src).toMatch(/<RedeemCard[\s\S]*\binviteId=\{/);
  });
});

describe('P1-7 — /redeem targets the redeem-invite Edge Function', () => {
  it('the route reads PUBLIC_SUPABASE_URL with a localhost:54321 fallback (mirror /sign-in)', () => {
    const src = pageSrc();
    expect(src).toMatch(/env\.PUBLIC_SUPABASE_URL/);
    expect(src).toMatch(/localhost:54321/);
  });

  it('the route wires the transport to the `redeem-invite` Edge Function endpoint', () => {
    const src = pageSrc();
    // Either via a factory (opName: 'redeem-invite') or an inline fetch to
    // /functions/v1/redeem-invite — both are accepted; what is load-bearing
    // is that the endpoint is redeem-invite.
    expect(src).toMatch(/redeem-invite/);
  });

  it('the route does NOT target bootstrap-first-co-chair or mint-session (wrong EF)', () => {
    const src = pageSrc();
    expect(src).not.toMatch(/bootstrap-first-co-chair/);
    expect(src).not.toMatch(/functions\/v1\/mint-session/);
  });
});

describe('P1-7 — /redeem SSR + indexing posture', () => {
  it('the route sets prerender=true + ssr=false (no PI at mount; matches /sign-in)', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the route carries a noindex,nofollow robots meta tag (Surface J)', () => {
    const src = pageSrc();
    expect(src).toMatch(/name=["']robots["']\s+content=["'][^"']*noindex/);
    expect(src).toMatch(/name=["']robots["']\s+content=["'][^"']*nofollow/);
  });
});

describe('P1-7 — /redeem i18n + production-strip discipline', () => {
  it('the route resolves visible strings via t() from $lib/i18n (no raw English prose)', () => {
    const src = pageSrc();
    expect(src).toMatch(/import\s*{[^}]*\bt\b[^}]*}\s+from\s+['"]\$lib\/i18n['"]/);
    // At minimum the page title/intro resolve via the redeem.* namespace.
    expect(src).toMatch(/t\(['"]redeem\.title['"]\)/);
    expect(src).toMatch(/t\(['"]redeem\.intro['"]\)/);
  });

  it('the route carries NO `__test_*` prop (ADR-0020 Decision 8 production strip)', () => {
    const src = pageSrc();
    const probe = '__test_';
    expect(src.includes(probe)).toBe(false);
  });
});

describe('P1-7 — /redeem F-170/F-176 structural URL guard', () => {
  it('the route source never appends a totp/code parameter to a URL (F-170)', () => {
    const src = pageSrc();
    // No querystring construction that carries the secret. The code/totp
    // travels ONLY in the register POST body (asserted behaviorally in
    // redeem-card.test.ts); the route shell must never put it in a URL.
    expect(src).not.toMatch(/[?&](totp_code|totp|code)=/);
    expect(src).not.toMatch(/searchParams\.set\(\s*['"](totp_code|totp|code)['"]/);
  });
});
