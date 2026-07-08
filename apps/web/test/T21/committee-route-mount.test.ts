/**
 * ADR-0029 P1-8b — /committee production route mount (structural contract).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. Mirrors
 * redeem-route-mount.test.ts + phase2a-concerns-page-cutover.test.ts: route
 * shells import `$app/*` + `$env/dynamic/public`, which the vitest runner does
 * not mount cleanly, so they are pinned STRUCTURALLY (a file-read on the shell).
 * The RENDERED behavior lives in committee-roster.test.ts on the composed
 * `CommitteeRoster` lib component.
 *
 * The route shell's load-bearing contract (Surface K route shell + A-8.4):
 *   - exists at apps/web/src/routes/committee/+page.svelte
 *   - constructs the committee client via createSupabaseCommitteeClient over
 *     PUBLIC_SUPABASE_URL (localhost:54321 fallback), wiring getJwt +
 *     onSessionRevoked=clearJwt (mirror /concerns + /reprisal)
 *   - composes the CommitteeRoster lib component, forwarding the client
 *   - the roster read is parameterless — the route NEVER puts member PI / a raw
 *     uid into a URL / query string (F-178 / F-176)
 *   - prerender=true + ssr=false (no PI on the route surface; matches every
 *     other route shell's +page.ts)
 *   - noindex,nofollow robots meta (Surface K: the roster is not indexed)
 *   - resolves visible strings via t() against the committee.* namespace
 *   - carries NO `__test_*` prop (ADR-0020 Decision 8 production strip)
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_DIR = resolve(__dirname, '../../src/routes/committee');
const PAGE_PATH = resolve(ROUTE_DIR, '+page.svelte');
const PAGE_TS_PATH = resolve(ROUTE_DIR, '+page.ts');

function pageSrc(): string {
  return readFileSync(PAGE_PATH, 'utf8');
}

describe('P1-8b — /committee route exists + composes CommitteeRoster', () => {
  it('the /committee route exists at apps/web/src/routes/committee/+page.svelte', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the route imports the CommitteeRoster lib component', () => {
    expect(pageSrc()).toMatch(
      /import\s+CommitteeRoster\s+from\s+['"][^'"]*lib\/committee\/CommitteeRoster\.svelte['"]/
    );
  });

  it('the route forwards a committee client into CommitteeRoster (client prop)', () => {
    // Accept the explicit `client={...}` binding OR Svelte's `{client}` shorthand.
    expect(pageSrc()).toMatch(/<CommitteeRoster[\s\S]*(\bclient=\{|\{client\})/);
  });
});

describe('P1-8b — /committee wires the committee-op client (A-8.3)', () => {
  it('the route constructs the client via createSupabaseCommitteeClient', () => {
    const src = pageSrc();
    expect(src).toMatch(/createSupabaseCommitteeClient/);
  });

  it('the route reads PUBLIC_SUPABASE_URL with a localhost:54321 fallback (mirror /concerns)', () => {
    const src = pageSrc();
    expect(src).toMatch(/env\.PUBLIC_SUPABASE_URL/);
    expect(src).toMatch(/localhost:54321/);
  });

  it('the route wires the F-39 revocation loop (onSessionRevoked → clearJwt) like the other authed routes', () => {
    const src = pageSrc();
    expect(src).toMatch(/onSessionRevoked/);
    expect(src).toMatch(/clearJwt/);
  });
});

describe('P1-8b — /committee SSR + indexing posture', () => {
  it('the route sets prerender=true + ssr=false (no PI at mount; matches every route shell)', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the route carries a noindex,nofollow robots meta tag (Surface K)', () => {
    const src = pageSrc();
    expect(src).toMatch(/name=["']robots["']\s+content=["'][^"']*noindex/);
    expect(src).toMatch(/name=["']robots["']\s+content=["'][^"']*nofollow/);
  });
});

describe('P1-8b — /committee i18n + production-strip discipline', () => {
  it('the route resolves visible strings via t() from the committee.* namespace', () => {
    const src = pageSrc();
    expect(src).toMatch(/import\s*{[^}]*\bt\b[^}]*}\s+from\s+['"]\$lib\/i18n['"]/);
    expect(src).toMatch(/t\(['"]committee\.roster\.title['"]\)/);
  });

  it('the route carries NO `__test_*` prop (ADR-0020 Decision 8 production strip)', () => {
    const src = pageSrc();
    expect(src.includes('__test_')).toBe(false);
  });
});

describe('P1-8b — /committee F-178/F-176 structural URL guard', () => {
  it('the route never appends member PI or a raw uid to a URL / query string', () => {
    const src = pageSrc();
    // The B1 roster read is parameterless + JWT-bound (A-8.3). No query-string
    // construction that carries a uid or PI field.
    expect(src).not.toMatch(/searchParams\.set\(\s*['"](user_id|target_user_id|display_name|off_employer_contact)['"]/);
    expect(src).not.toMatch(/[?&](user_id|target_user_id|display_name|off_employer_contact)=/);
  });

  it('the route does NOT call listPendingInvites (P1-8b renders the B1 roster ONLY)', () => {
    // The pending-invite read + re-send actions are P1-8c. Interleaving B2 here
    // would double-render every pending member (Surface K read-boundary note).
    expect(pageSrc()).not.toMatch(/listPendingInvites/);
  });
});
