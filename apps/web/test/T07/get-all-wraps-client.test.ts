/**
 * F182-1 — SupabaseT07Client.getAllCommitteeKeyWrapsForSelf() wire-shape tests
 * (ADR-0030 Decision 6; threat-model §3.18 Amendment A-8.10, finding F-183 —
 * the anti-lockout keystone).
 *
 * RED-FIRST (TDD): the method does NOT exist on SupabaseT07Client yet, so every
 * test here fails against `main` (the method is undefined — a TypeError). The
 * implementer adds `getAllCommitteeKeyWrapsForSelf()` to make them pass. The
 * implementer treats this file as READ-ONLY.
 *
 * CONTRACT UNDER TEST (mirrors getCommitteeKeyWrapForSelf's thin-wrapper shape
 * — src/lib/crypto/supabase-t07-client.ts — generalized from the SINGLE live
 * wrap to the MULTI-epoch SETOF):
 *
 *   getAllCommitteeKeyWrapsForSelf():
 *     Promise<T07OpResult<Array<{
 *       key_id: string;
 *       epoch: number;
 *       wrapped_ciphertext: Uint8Array;   // decoded from PostgREST hex
 *       is_live: boolean;
 *     }>>>
 *
 *   - POSTs { op: 'get_all_key_wraps' } — NO id/target parameter (own-wrap-only
 *     is structural; F-183 (i) no-IDOR — mirrors the parameterless
 *     { op: 'get_key_wrap' }).
 *   - Parses the SETOF: each server row { key_id, epoch, wrapped_ciphertext_hex,
 *     is_live } → { key_id, epoch, wrapped_ciphertext: pgHexToBytes(hex),
 *     is_live } (hex→Uint8Array on wrapped_ciphertext, mirroring
 *     getCommitteeKeyWrapForSelf / getRecoveryBlob).
 *   - Surfaces the is_live flag per row (the client's live-key designation
 *     for sealing).
 *   - Empty SETOF ([]) → { ok: true, data: [] } (a purged/reactivated member in
 *     the holding state — never a throw).
 *   - An { ok: false } transport (a server denial) → a typed failure
 *     { ok: false, reason, status } surfaced verbatim (never throws).
 *   - A THROWN transport (network/transport fault) → a typed failure
 *     (ok: false) — the method must NOT reject.
 */

import { describe, expect, it } from 'vitest';
import {
  SupabaseT07Client,
  bytesToPgHex,
  type T07OpTransport
} from '../../src/lib/crypto';

function mockTransport(
  responses: Array<{ status: number; body: unknown }>
): { transport: T07OpTransport; calls: Array<{ body: Record<string, unknown> }> } {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport: T07OpTransport = async (body) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error(`mockTransport: no response queued for call #${calls.length}`);
    return r;
  };
  return { transport, calls };
}

// A throwing transport — models a network/transport fault (fetch reject). The
// method under test must catch this and surface a typed failure, never reject.
function throwingTransport(): T07OpTransport {
  return async () => {
    throw new Error('network down');
  };
}

describe('F182-1 — SupabaseT07Client.getAllCommitteeKeyWrapsForSelf (multi-epoch read, F-183)', () => {
  it('POSTs { op: get_all_key_wraps } with NO id parameter (own-wrap-only is structural, no IDOR)', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: [] } }]);
    const client = new SupabaseT07Client({ transport });

    await client.getAllCommitteeKeyWrapsForSelf();

    expect(calls[0]?.body).toEqual({ op: 'get_all_key_wraps' });
  });

  it('parses the SETOF, decoding wrapped_ciphertext hex→Uint8Array per row and surfacing is_live', async () => {
    const { transport } = mockTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: [
            {
              key_id: '22222222-2222-2222-2222-222222222201',
              epoch: 1,
              wrapped_ciphertext_hex: bytesToPgHex(new Uint8Array([0xaa, 0x01])),
              is_live: false
            },
            {
              key_id: '22222222-2222-2222-2222-222222222202',
              epoch: 2,
              wrapped_ciphertext_hex: bytesToPgHex(new Uint8Array([0xaa, 0x02])),
              is_live: true
            }
          ]
        }
      }
    ]);
    const client = new SupabaseT07Client({ transport });

    const r = await client.getAllCommitteeKeyWrapsForSelf();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Both epochs surface (retired + live) — the anti-lockout property carried
    // to the client seam.
    expect(r.data).toEqual([
      {
        key_id: '22222222-2222-2222-2222-222222222201',
        epoch: 1,
        wrapped_ciphertext: new Uint8Array([0xaa, 0x01]),
        is_live: false
      },
      {
        key_id: '22222222-2222-2222-2222-222222222202',
        epoch: 2,
        wrapped_ciphertext: new Uint8Array([0xaa, 0x02]),
        is_live: true
      }
    ]);
  });

  it('surfaces is_live: exactly the live-epoch row is flagged true, retired rows false', async () => {
    const { transport } = mockTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: [
            {
              key_id: 'k-retired',
              epoch: 1,
              wrapped_ciphertext_hex: bytesToPgHex(new Uint8Array([0x01])),
              is_live: false
            },
            {
              key_id: 'k-live',
              epoch: 2,
              wrapped_ciphertext_hex: bytesToPgHex(new Uint8Array([0x02])),
              is_live: true
            }
          ]
        }
      }
    ]);
    const client = new SupabaseT07Client({ transport });

    const r = await client.getAllCommitteeKeyWrapsForSelf();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const live = r.data.filter((w) => w.is_live);
    expect(live).toHaveLength(1);
    expect(live[0]?.key_id).toBe('k-live');
    expect(r.data.filter((w) => !w.is_live).map((w) => w.key_id)).toEqual(['k-retired']);
  });

  it('returns { ok: true, data: [] } for a member with no wraps (holding state, no throw)', async () => {
    const { transport } = mockTransport([{ status: 200, body: { ok: true, data: [] } }]);
    const client = new SupabaseT07Client({ transport });

    const r = await client.getAllCommitteeKeyWrapsForSelf();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([]);
  });

  it('a retired-ONLY holder surfaces rows with NO is_live=true entry (routes to holding state)', async () => {
    const { transport } = mockTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: [
            {
              key_id: 'k-retired',
              epoch: 1,
              wrapped_ciphertext_hex: bytesToPgHex(new Uint8Array([0xee, 0x01])),
              is_live: false
            }
          ]
        }
      }
    ]);
    const client = new SupabaseT07Client({ transport });

    const r = await client.getAllCommitteeKeyWrapsForSelf();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data.some((w) => w.is_live)).toBe(false);
  });

  it('maps an { ok: false } server denial to a typed failure (rls_denied / 403), never throws', async () => {
    const { transport } = mockTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = new SupabaseT07Client({ transport });

    const r = await client.getAllCommitteeKeyWrapsForSelf();

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
    expect(r.status).toBe(403);
  });

  it('does not reject when the transport throws — surfaces a typed failure instead', async () => {
    const client = new SupabaseT07Client({ transport: throwingTransport() });

    // The method must RESOLVE (never reject) even on a transport fault.
    const r = await client.getAllCommitteeKeyWrapsForSelf();

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // A typed reason from the closed T07OpReason union (not an uncaught throw).
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
