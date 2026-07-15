/**
 * F-183-B — fresh-session / baseline multi-epoch anti-lockout (F182-2 panel
 * keystone gap; threat-model §3.18, second-opinion Concern 2).
 *
 * ┌─ INTENTIONAL PENDING GATE — DO NOT DELETE, DO NOT UN-SKIP YET ────────────┐
 * │ This test is committed IN F182-2 as an EXECUTABLE record of an OPEN gap,  │
 * │ not a forgotten/broken test. It is `it.skip` ON PURPOSE.                  │
 * │                                                                           │
 * │ The gap (verified): the multi-epoch re-populate is gated on              │
 * │ `keyHolder.isPopulated() && getKeyId() !== probe.key_id`                 │
 * │ (concerns/production-flows.ts:157). On a FRESH session the holder is     │
 * │ EMPTY, so that branch is skipped and the initial load falls to the       │
 * │ SINGLE-live-key path (`unwrapCommitteeDataKeyViaProduction` +            │
 * │ `keyHolder.set(...)`, :184-205). A post-rotation fresh session therefore │
 * │ loads ONLY the live epoch and never the retired epoch it needs to read   │
 * │ pre-rotation data → `trialOpen` misses every pre-rotation row → the      │
 * │ whole list aborts `decrypt_failed` (:446-448). That is the exact F-183   │
 * │ anti-lockout catastrophe, on the COMMON re-sign-in path.                 │
 * │                                                                           │
 * │ Why skipped, not red: the fix is a DEDICATED tranche (F182-3) sequenced  │
 * │ BEFORE F182-4. Landing it red inside F182-2 would falsely fail the       │
 * │ F182-2 gate for a defect F182-2 does not own. Per the panel disposition, │
 * │ F182-4 (rotation composition) is HARD-BLOCKED on F-183-B closing; this   │
 * │ skipped test is what documents the keystone gap until F182-3 lands.      │
 * │                                                                           │
 * │ Un-skip WHEN F182-3 makes the baseline load multi-epoch (initial         │
 * │ populate via `unwrapAllCommitteeKeysViaProduction`+`populate()` when the │
 * │ probe shows the actor holds a wrap, OR escalate-to-unwrap-all on the     │
 * │ first `trialOpen` miss). At that point this test MUST pass.              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Hermetic: real libsodium (secretbox + sealed-box); mock t07/concern
 * transports; a real BrowserLocalIdentityStore (SSR-fallback Map); a real
 * CommitteeKeyHolder. No real clock, no real network, no seeded-RNG assertion
 * (assertions are on the DECRYPT round-trip / list outcome, never on raw
 * ciphertext bytes). Determinism: created_at is set from `Date.now()` exactly
 * as the sibling flow tests do, and `days_since_filed` is not asserted here, so
 * no clock control is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  CommitteeKeyHolder,
  SupabaseT07Client,
  type T07OpTransport
} from '../../src/lib/crypto';
import {
  SupabaseConcernClient,
  type ConcernOpTransport
} from '../../src/lib/concerns/supabase-concern-client';
import { listConcernsViaProduction } from '../../src/lib/concerns';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a';

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

/** Seal a UTF-8 plaintext under a secretbox key → on-wire `[nonce][ct]` pg-hex. */
function sealHex(pt: string, key: Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ptBytes = new Uint8Array(new TextEncoder().encode(pt));
  const ct = sodium.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToPgHex(out);
}

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  allWraps: Array<{ key_id: string; epoch: number; wrap: Uint8Array; is_live: boolean }> | null;
}

function makeT07Transport(srv: FakeKeyServer): { transport: T07OpTransport; ops: string[] } {
  const ops: string[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
    if (body.op === 'committee_key_state') {
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            key_id: srv.liveKeyId,
            epoch: srv.liveEpoch,
            wrap_count: srv.actorHasWrap ? (srv.allWraps?.length ?? 1) : 0,
            actor_has_wrap: srv.actorHasWrap
          }
        }
      };
    }
    if (body.op === 'get_key_wrap') {
      if (!srv.liveWrap) return { status: 200, body: { ok: true, data: null } };
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            key_id: srv.liveKeyId,
            epoch: srv.liveEpoch,
            wrapped_ciphertext_hex: bytesToPgHex(srv.liveWrap)
          }
        }
      };
    }
    if (body.op === 'get_all_key_wraps') {
      const rows = srv.allWraps ?? [];
      return {
        status: 200,
        body: {
          ok: true,
          data: rows.map((r) => ({
            key_id: r.key_id,
            epoch: r.epoch,
            wrapped_ciphertext_hex: bytesToPgHex(r.wrap),
            is_live: r.is_live
          }))
        }
      };
    }
    throw new Error(`unexpected op ${String(body.op)}`);
  };
  return { transport, ops };
}

function makeConcernTransport(queue: Array<{ status: number; body: unknown }>): {
  transport: ConcernOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const transport: ConcernOpTransport = async (body) => {
    bodies.push(body);
    const r = queue[i++];
    if (!r) throw new Error(`concern: no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

/**
 * A FRESH signed-in session (EMPTY holder) after the committee has rotated to
 * epoch-2. The member legitimately holds BOTH a retired epoch-1 wrap and the
 * live epoch-2 wrap (get_all_key_wraps), each sealed to the actor pubkey. The
 * single-live probe reports only the live epoch-2 key_id.
 */
async function buildBaselineRotatedSession() {
  const retiredKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const liveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const localIdentity = silentStore();
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

  const srv: FakeKeyServer = {
    liveKeyId: 'k-epoch-2',
    liveEpoch: 2,
    actorHasWrap: true,
    liveWrap: sodium.crypto_box_seal(liveKey, kp.publicKey),
    allWraps: [
      { key_id: 'k-epoch-1', epoch: 1, wrap: sodium.crypto_box_seal(retiredKey, kp.publicKey), is_live: false },
      { key_id: 'k-epoch-2', epoch: 2, wrap: sodium.crypto_box_seal(liveKey, kp.publicKey), is_live: true }
    ]
  };
  const t07 = makeT07Transport(srv);
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  // FRESH session — the holder starts EMPTY (no prior key_id to delta against).
  const keyHolder = new CommitteeKeyHolder();

  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey };
}

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

// ===========================================================================
// F-183-B — the from-empty-holder anti-lockout keystone gap. PENDING.
// ===========================================================================
describe('F-183-B — fresh-session baseline multi-epoch anti-lockout (PENDING / F182-4 hard-block)', () => {
  it.skip('F-183-B (PENDING; F182-4 hard-block) — an EMPTY holder loaded on a fresh post-rotation session holding {retired epoch-1, live epoch-2} STILL opens a pre-rotation (epoch-1-sealed) row', async () => {
    const { t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();

    // Precondition of the gap: the session starts with an EMPTY holder, so the
    // within-session key_id delta detector never fires — the baseline load must
    // itself be multi-epoch (the F182-3 fix) for this to pass.
    expect(keyHolder.isPopulated()).toBe(false);

    // A pre-rotation concern row, sealed under the RETIRED epoch-1 key. On the
    // fixed baseline path the retired epoch is loaded, so trial-decrypt opens it.
    const nowIso = new Date().toISOString();
    const rowsFromView = [
      {
        id: 'c-pre',
        title_ct: sealHex('history-title-under-retired-epoch-1', retiredKey),
        body_ct: sealHex('history-body-under-retired-epoch-1', retiredKey),
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        created_at: nowIso,
        actor_pseudonym: 'p-pre',
        anonymous_default_kept: true,
        has_named_source: false,
        key_id: 'k-epoch-1'
      }
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rowsFromView } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    // The keystone assertion the F182-3 fix must satisfy: no whole-page
    // decrypt_failed lockout on the common re-sign-in path.
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.title).toBe('history-title-under-retired-epoch-1');
    expect(r.items[0]!.body).toBe('history-body-under-retired-epoch-1');

    // …and the baseline load brought in BOTH epochs (retired read key retained).
    expect(keyHolder.size()).toBeGreaterThanOrEqual(2);
    expect(keyHolder.getKeyId()).toBe('k-epoch-2');
  });
});
