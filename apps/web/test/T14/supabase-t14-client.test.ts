/**
 * T14.1 — G-T14-2 Supabase{WorkRefusal,S51Evidence}Client tests.
 *
 * Hermetic: a stub T14OpTransport records request bodies + returns canned
 * responses. Asserts arg forwarding for each high-level op, bytea hex
 * encoding/decoding round-trips, the HG-6 null-on-deny audited-read
 * contract, the photos_ct[] array mapping for s.51, and the denial-reason
 * surface (rls_denied 403, not_found 404, invalid_input 422).
 */

import { describe, expect, it } from 'vitest';
import {
  SupabaseS51EvidenceClient,
  SupabaseWorkRefusalClient,
  type T14OpTransport
} from '../../src/lib/work-refusal/supabase-t14-client';

function mockTransport(
  responses: Array<{ status: number; body: unknown }>
): { transport: T14OpTransport; calls: Array<{ body: Record<string, unknown> }> } {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport: T14OpTransport = async (body) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error(`mockTransport: no response queued for call #${calls.length}`);
    return r;
  };
  return { transport, calls };
}

// ===========================================================================
// SupabaseWorkRefusalClient (s.43)
// ===========================================================================

describe('T14.1 / G-T14-2 — SupabaseWorkRefusalClient.submitWorkRefusal', () => {
  it('posts { op: wr_submit } with bytea-hex-encoded ciphertexts + passphrase', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { id: 'wr-1' } } }
    ]);
    const client = new SupabaseWorkRefusalClient({ transport });
    const r = await client.submitWorkRefusal({
      title_ct: new Uint8Array([0x71]),
      notes_ct: new Uint8Array([0xbe, 0xef]),
      passphrase: 'wr-pass'
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ id: 'wr-1' });
    expect(calls[0]?.body).toEqual({
      op: 'wr_submit',
      title_ct: '\\x71',
      notes_ct: '\\xbeef',
      passphrase: 'wr-pass'
    });
  });

  it('defaults passphrase to null when omitted', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { id: 'wr-2' } } }
    ]);
    const client = new SupabaseWorkRefusalClient({ transport });
    await client.submitWorkRefusal({
      title_ct: new Uint8Array([0x01]),
      notes_ct: new Uint8Array([0x02])
    });
    expect(calls[0]?.body).toMatchObject({ passphrase: null });
  });

  it('surfaces 403 rls_denied (F-21: a non-certified caller)', async () => {
    const { transport } = mockTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = new SupabaseWorkRefusalClient({ transport });
    const r = await client.submitWorkRefusal({
      title_ct: new Uint8Array([0]),
      notes_ct: new Uint8Array([0])
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
    expect(r.status).toBe(403);
  });
});

describe('T14.1 / G-T14-2 — SupabaseWorkRefusalClient.readWorkRefusal (HG-6)', () => {
  it('decodes the bytea hex back to Uint8Array on success', async () => {
    const { transport, calls } = mockTransport([
      {
        status: 200,
        body: { ok: true, data: { title_ct: '\\x71', notes_ct: '\\xbeef' } }
      }
    ]);
    const client = new SupabaseWorkRefusalClient({ transport });
    const r = await client.readWorkRefusal({ id: 'wr-1', passphrase: 'wr-pass' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      title_ct: new Uint8Array([0x71]),
      notes_ct: new Uint8Array([0xbe, 0xef])
    });
    expect(calls[0]?.body).toEqual({ op: 'wr_read', id: 'wr-1', passphrase: 'wr-pass' });
  });

  it('returns { ok: true, data: null } for wrong-passphrase / row-missing (HG-6 contract)', async () => {
    const { transport } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseWorkRefusalClient({ transport });
    const r = await client.readWorkRefusal({ id: 'wr-1', passphrase: 'wrong' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toBeNull();
  });

  it('surfaces 403 rls_denied for a plain-member caller (F-21 read)', async () => {
    const { transport } = mockTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = new SupabaseWorkRefusalClient({ transport });
    const r = await client.readWorkRefusal({ id: 'wr-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
  });
});

describe('T14.1 / G-T14-2 — SupabaseWorkRefusalClient.updateWorkRefusal (F-31)', () => {
  it('forwards only the provided patch fields (NULL omission)', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseWorkRefusalClient({ transport });
    await client.updateWorkRefusal({ id: 'wr-1', notes_ct: new Uint8Array([0xd0, 0x0d]) });
    expect(calls[0]?.body).toEqual({ op: 'wr_update', id: 'wr-1', notes_ct: '\\xd00d' });
  });

  it('forwards both ciphertext fields when both are present', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseWorkRefusalClient({ transport });
    await client.updateWorkRefusal({
      id: 'wr-1',
      title_ct: new Uint8Array([0xaa]),
      notes_ct: new Uint8Array([0xbb])
    });
    expect(calls[0]?.body).toEqual({
      op: 'wr_update',
      id: 'wr-1',
      title_ct: '\\xaa',
      notes_ct: '\\xbb'
    });
  });

  it('surfaces 404 not_found', async () => {
    const { transport } = mockTransport([
      { status: 404, body: { ok: false, error: 'not_found' } }
    ]);
    const client = new SupabaseWorkRefusalClient({ transport });
    const r = await client.updateWorkRefusal({ id: 'missing', title_ct: new Uint8Array([0]) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
    expect(r.status).toBe(404);
  });
});

// ===========================================================================
// SupabaseS51EvidenceClient (s.51)
// ===========================================================================

describe('T14.1 / G-T14-2 — SupabaseS51EvidenceClient.submitS51Evidence', () => {
  it('posts { op: s51_submit } with title/notes/photos all bytea-hex-encoded', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { id: 's-1' } } }
    ]);
    const client = new SupabaseS51EvidenceClient({ transport });
    const r = await client.submitS51Evidence({
      title_ct: new Uint8Array([0x51]),
      notes_ct: new Uint8Array([0xca, 0xfe]),
      photos: [new Uint8Array([0xaa]), new Uint8Array([0xbb])],
      passphrase: 's-pass'
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ id: 's-1' });
    expect(calls[0]?.body).toEqual({
      op: 's51_submit',
      title_ct: '\\x51',
      notes_ct: '\\xcafe',
      photos_ct: ['\\xaa', '\\xbb'],
      passphrase: 's-pass'
    });
  });

  it('defaults photos to [] and passphrase to null when omitted', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { id: 's-2' } } }
    ]);
    const client = new SupabaseS51EvidenceClient({ transport });
    await client.submitS51Evidence({
      title_ct: new Uint8Array([0x01]),
      notes_ct: new Uint8Array([0x02])
    });
    expect(calls[0]?.body).toMatchObject({ photos_ct: [], passphrase: null });
  });

  it('surfaces 422 invalid_input (e.g. SQL CHECK violation on status enum)', async () => {
    const { transport } = mockTransport([
      { status: 422, body: { ok: false, error: 'invalid_input' } }
    ]);
    const client = new SupabaseS51EvidenceClient({ transport });
    const r = await client.submitS51Evidence({
      title_ct: new Uint8Array([0]),
      notes_ct: new Uint8Array([0])
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid_input');
    expect(r.status).toBe(422);
  });
});

describe('T14.1 / G-T14-2 — SupabaseS51EvidenceClient.readS51Evidence (HG-6)', () => {
  it('decodes title/notes + each photos[] entry from bytea hex', async () => {
    const { transport, calls } = mockTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            title_ct: '\\x51',
            notes_ct: '\\xcafe',
            photos_ct: ['\\xaa', '\\xbb']
          }
        }
      }
    ]);
    const client = new SupabaseS51EvidenceClient({ transport });
    const r = await client.readS51Evidence({ id: 's-1', passphrase: 's-pass' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      title_ct: new Uint8Array([0x51]),
      notes_ct: new Uint8Array([0xca, 0xfe]),
      photos: [new Uint8Array([0xaa]), new Uint8Array([0xbb])]
    });
    expect(calls[0]?.body).toEqual({ op: 's51_read', id: 's-1', passphrase: 's-pass' });
  });

  it('handles a missing photos_ct field on the wire as an empty array', async () => {
    const { transport } = mockTransport([
      {
        status: 200,
        body: { ok: true, data: { title_ct: '\\x51', notes_ct: '\\xcafe' } }
      }
    ]);
    const client = new SupabaseS51EvidenceClient({ transport });
    const r = await client.readS51Evidence({ id: 's-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.photos).toEqual([]);
  });

  it('returns { ok: true, data: null } for wrong-passphrase / row-missing (HG-6 contract)', async () => {
    const { transport } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseS51EvidenceClient({ transport });
    const r = await client.readS51Evidence({ id: 's-1', passphrase: 'wrong' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toBeNull();
  });
});

describe('T14.1 / G-T14-2 — SupabaseS51EvidenceClient.updateS51Evidence (F-31)', () => {
  it('forwards only the provided patch fields (NULL omission)', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseS51EvidenceClient({ transport });
    await client.updateS51Evidence({ id: 's-1', title_ct: new Uint8Array([0xff]) });
    expect(calls[0]?.body).toEqual({ op: 's51_update', id: 's-1', title_ct: '\\xff' });
  });

  it('does NOT accept a photos field (statutory append-only posture)', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseS51EvidenceClient({ transport });
    // The TS type rejects `photos` on update; assert at runtime that even if a
    // caller smuggles it in via `as any`, the client does NOT forward it.
    await client.updateS51Evidence({ id: 's-1', notes_ct: new Uint8Array([0xab]) } as never);
    expect(calls[0]?.body).not.toHaveProperty('photos_ct');
  });
});
