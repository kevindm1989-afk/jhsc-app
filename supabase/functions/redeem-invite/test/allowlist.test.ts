/**
 * redeem-invite / F-122-F-123 allowlist re-pass self-test — ADR-0029 P1-2.
 *
 * Run: `deno test --allow-read supabase/functions/redeem-invite/test/allowlist.test.ts`
 *
 * The redeem EF is verify_jwt=false UNAUTHENTICATED-by-necessity (the invitee
 * has no JWT) so it legitimately skips the per-dispatcher session_is_live()
 * precheck — exactly like mint-session/challenge and bootstrap-first-co-chair.
 * F-122/F-123 require a threat-model re-pass for any addition to that exemption
 * set; threat-model §3.18/F-168 IS that re-pass. This test pins the contract so
 * that when the implementer creates supabase/functions/redeem-invite/index.ts,
 * the scripts/verify-session-live-uniformity.sh gate is satisfied (it would
 * otherwise FAIL the new EF as "not wired AND not exempt").
 *
 * RED-FIRST: `redeem-invite` is NOT on the PERMANENT_ALLOWLIST in the script on
 * `main` yet (the implementer adds it with the §3.18/F-168 re-pass note as part
 * of P1-2). Until then assertions (1)+(2) fail.
 *
 * Findings covered (threat-model §3.18):
 *   F-168 — redeem-invite on the allowlist (unauthenticated-by-necessity), WITH
 *           a §3.18 / F-168 re-pass note in the script comment block; the SQL
 *           terminal stays mint_writer-only (pinned in phase1_redeem_invite_rls).
 *   F-170 / F-176 — the redeem LINK carries only invite_id, never the code (the
 *           code is member-entered, never appended to a URL/query).
 */

function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}

const REPO_ROOT = new URL('../../../../', import.meta.url); // supabase/functions/redeem-invite/test -> repo root
const SCRIPT_PATH = new URL('scripts/verify-session-live-uniformity.sh', REPO_ROOT);

async function readScript(): Promise<string> {
  return await Deno.readTextFile(SCRIPT_PATH);
}

// ---------------------------------------------------------------------------
// (1) F-168 — `redeem-invite` is on the PERMANENT_ALLOWLIST constant.
// ---------------------------------------------------------------------------
Deno.test('F-168: redeem-invite is on the session-live PERMANENT_ALLOWLIST', async () => {
  const script = await readScript();
  // Extract the PERMANENT_ALLOWLIST=( ... ) block and assert the slug is inside.
  const m = script.match(/PERMANENT_ALLOWLIST=\(([\s\S]*?)\)/);
  assert(m, 'PERMANENT_ALLOWLIST block not found in the uniformity script');
  const block = m![1];
  assert(
    /["']redeem-invite["']/.test(block),
    'F-168: "redeem-invite" must be listed in PERMANENT_ALLOWLIST (unauthenticated-by-necessity)',
  );
  // It must NOT be parked on the temporary rollout-exempt list (that would let
  // it ship without the deliberate threat-model re-pass).
  const rollout = script.match(/EXEMPT_DURING_ROLLOUT=\(([\s\S]*?)\)/);
  if (rollout) {
    assert(
      !/["']redeem-invite["']/.test(rollout[1]),
      'redeem-invite must be on the PERMANENT allowlist, not the temporary rollout-exempt list',
    );
  }
});

// ---------------------------------------------------------------------------
// (2) F-168 — the allowlist addition cites the §3.18 / F-168 re-pass authority.
// ---------------------------------------------------------------------------
Deno.test('F-168: the allowlist addition cites the §3.18 / F-168 threat-model re-pass', async () => {
  const script = await readScript();
  assert(
    script.includes('F-168') && (script.includes('3.18') || script.includes('§3.18')),
    'F-168: the uniformity script must cite §3.18 / F-168 as the authority for adding redeem-invite',
  );
});

// ---------------------------------------------------------------------------
// (3) F-170 / F-176 — the redeem LINK carries only invite_id, never the code.
//     The /redeem route/link builder must put ONLY invite_id in the URL; the
//     6-digit code is member-entered in the form, never in a query string.
//     RED-FIRST: the link builder does not exist yet (P1-2/P1-7 helper).
// ---------------------------------------------------------------------------
Deno.test('F-170/F-176: the redeem link carries only invite_id, never the code', async () => {
  const mod = await import('../core.ts');
  // The core must export a redeem-link builder that takes ONLY an invite_id.
  const buildRedeemLink = (mod as { buildRedeemLink?: (opts: { invite_id: string; base?: string }) => string })
    .buildRedeemLink;
  assert(
    typeof buildRedeemLink === 'function',
    'core.ts must export buildRedeemLink({ invite_id }) — the code is never put in a URL',
  );
  const url = buildRedeemLink!({ invite_id: '11111111-1111-1111-1111-111111111111', base: 'https://app.example' });
  assert(url.includes('11111111-1111-1111-1111-111111111111'), 'the link must carry invite_id');
  // The function signature must NOT accept a code; and a probe code must never
  // appear in the produced URL (constraints.md "No PII in URL query strings").
  assert(
    !/code|totp/i.test(new URL(url).search),
    'F-170/F-176: the redeem URL query must contain no code/totp parameter',
  );
});
