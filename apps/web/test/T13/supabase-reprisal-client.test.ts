/**
 * T13.1 — G-T13-2 SupabaseReprisalClient tests.
 *
 * Hermetic: a stub `ReprisalOpTransport` records request bodies + returns
 * canned responses. Asserts arg forwarding for each high-level op, bytea
 * hex encoding/decoding round-trips, the audited-read null-on-deny
 * surface, and the full denial-reason matrix (rls_denied 403,
 * self_approve_denied 403, role_pair_invalid 403, rate_limited 429,
 * not_found 404, expired 409, invalid_status 422).
 */

import { describe, expect, it } from 'vitest';
import {
  SupabaseReprisalClient,
  type ReprisalFeedRow,
  type ReprisalOpTransport
} from '../../src/lib/reprisal/supabase-reprisal-client';

function mockTransport(
  responses: Array<{ status: number; body: unknown }>
): { transport: ReprisalOpTransport; calls: Array<{ body: Record<string, unknown> }> } {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport: ReprisalOpTransport = async (body) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error(`mockTransport: no response queued for call #${calls.length}`);
    return r;
  };
  return { transport, calls };
}

describe('T13.1 / G-T13-2 — SupabaseReprisalClient.submitReprisal', () => {
  it('posts { op: submit } with bytea-hex-encoded ciphertexts + passphrase', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { id: 'r-1' } } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.submitReprisal({
      title_ct: new Uint8Array([0xde, 0xad]),
      body_ct: new Uint8Array([0xbe, 0xef]),
      passphrase: 'hunter2'
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ id: 'r-1' });
    expect(calls[0]?.body).toEqual({
      op: 'submit',
      title_ct: '\\xdead',
      body_ct: '\\xbeef',
      passphrase: 'hunter2'
    });
  });

  it('defaults passphrase to null when omitted', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { id: 'r-2' } } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    await client.submitReprisal({
      title_ct: new Uint8Array([0x01]),
      body_ct: new Uint8Array([0x02])
    });
    expect(calls[0]?.body).toMatchObject({ passphrase: null });
  });

  it('surfaces 429 rate_limited verbatim', async () => {
    const { transport } = mockTransport([
      { status: 429, body: { ok: false, error: 'rate_limited' } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.submitReprisal({
      title_ct: new Uint8Array([0]),
      body_ct: new Uint8Array([0])
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rate_limited');
    expect(r.status).toBe(429);
  });
});

describe('T13.1 / G-T13-2 — SupabaseReprisalClient.readReprisal (HG-6)', () => {
  it('decodes the bytea hex back to Uint8Array on success', async () => {
    const { transport, calls } = mockTransport([
      {
        status: 200,
        body: { ok: true, data: { title_ct: '\\xdead', body_ct: '\\xbeef' } }
      }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.readReprisal({ id: 'r-1', passphrase: 'hunter2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      title_ct: new Uint8Array([0xde, 0xad]),
      body_ct: new Uint8Array([0xbe, 0xef])
    });
    expect(calls[0]?.body).toEqual({ op: 'read', id: 'r-1', passphrase: 'hunter2' });
  });

  it('returns { ok: true, data: null } for wrong-passphrase / row-missing (HG-6 contract)', async () => {
    const { transport } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.readReprisal({ id: 'r-1', passphrase: 'wrong' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toBeNull();
  });

  it('surfaces 403 rls_denied for a non-active-member caller', async () => {
    const { transport } = mockTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.readReprisal({ id: 'r-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
  });
});

describe('T13.1 / G-T13-2 — SupabaseReprisalClient.updateReprisal (F-31)', () => {
  it('forwards only the provided patch fields (NULL omission)', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseReprisalClient({ transport });
    await client.updateReprisal({ id: 'r-1', body_ct: new Uint8Array([0xd0, 0x0d]) });
    expect(calls[0]?.body).toEqual({ op: 'update', id: 'r-1', body_ct: '\\xd00d' });
  });

  it('forwards both ciphertext fields when both are present', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseReprisalClient({ transport });
    await client.updateReprisal({
      id: 'r-1',
      title_ct: new Uint8Array([0xaa]),
      body_ct: new Uint8Array([0xbb])
    });
    expect(calls[0]?.body).toEqual({
      op: 'update',
      id: 'r-1',
      title_ct: '\\xaa',
      body_ct: '\\xbb'
    });
  });

  it('surfaces 404 not_found', async () => {
    const { transport } = mockTransport([
      { status: 404, body: { ok: false, error: 'not_found' } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.updateReprisal({ id: 'missing', title_ct: new Uint8Array([0]) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
    expect(r.status).toBe(404);
  });
});

describe('T13.1 / G-T13-2 — HG-7 4-eyes status flip', () => {
  it('proposeStatusFlip forwards reprisal_id + new_status, returns pending_id', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { pending_id: 'pf-1' } } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.proposeStatusFlip({ reprisal_id: 'r-1', new_status: 'closed' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ pending_id: 'pf-1' });
    expect(calls[0]?.body).toEqual({
      op: 'propose_status',
      reprisal_id: 'r-1',
      new_status: 'closed'
    });
  });

  it('approveStatusFlip surfaces self_approve_denied (proposer == approver)', async () => {
    const { transport, calls } = mockTransport([
      { status: 403, body: { ok: false, error: 'self_approve_denied' } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.approveStatusFlip({ pending_id: 'pf-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('self_approve_denied');
    expect(r.status).toBe(403);
    expect(calls[0]?.body).toEqual({ op: 'approve_status', pending_id: 'pf-1' });
  });

  it('approveStatusFlip surfaces invalid_status (422)', async () => {
    const { transport } = mockTransport([
      { status: 422, body: { ok: false, error: 'invalid_status' } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.approveStatusFlip({ pending_id: 'pf-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid_status');
    expect(r.status).toBe(422);
  });
});

describe('T13.1 / G-T13-2 — Amendment E forensic reveal', () => {
  it('proposeForensicReveal forwards audit_log_id + reveal_reason, returns pending_id', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { pending_id: 'pf-2' } } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.proposeForensicReveal({
      audit_log_id: '12345',
      reveal_reason: 'incident-X investigation'
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ pending_id: 'pf-2' });
    expect(calls[0]?.body).toEqual({
      op: 'propose_forensic',
      audit_log_id: '12345',
      reveal_reason: 'incident-X investigation'
    });
  });

  it('approveForensicReveal returns the revealed actor pseudonym', async () => {
    const { transport, calls } = mockTransport([
      {
        status: 200,
        body: { ok: true, data: { revealed_actor_pseudonym: 'abc123def4567890' } }
      }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.approveForensicReveal({ pending_id: 'pf-2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.revealed_actor_pseudonym).toBe('abc123def4567890');
    expect(calls[0]?.body).toEqual({ op: 'approve_forensic', pending_id: 'pf-2' });
  });

  it('approveForensicReveal returns null pseudonym when the audit row was retention-wiped', async () => {
    const { transport } = mockTransport([
      { status: 200, body: { ok: true, data: { revealed_actor_pseudonym: null } } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.approveForensicReveal({ pending_id: 'pf-2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.revealed_actor_pseudonym).toBeNull();
  });

  it('approveForensicReveal surfaces role_pair_invalid (403)', async () => {
    const { transport } = mockTransport([
      { status: 403, body: { ok: false, error: 'role_pair_invalid' } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.approveForensicReveal({ pending_id: 'pf-2' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('role_pair_invalid');
    expect(r.status).toBe(403);
  });

  it('approveForensicReveal surfaces expired (409) after the 24h TTL', async () => {
    const { transport } = mockTransport([
      { status: 409, body: { ok: false, error: 'expired' } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.approveForensicReveal({ pending_id: 'pf-2' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('expired');
    expect(r.status).toBe(409);
  });
});

describe('T13.1 / G-T13-2 — Amendment D feed', () => {
  it('listReprisalFeed posts { op: feed } and returns the pseudonymized rows', async () => {
    const sample: ReprisalFeedRow = {
      id: 1,
      event_type: 'reprisal.created',
      ts_bucketed_to_hour: 1748400000000,
      target_id: '00000000-0000-0000-0000-000000000001',
      target_class: 'C4',
      prev_hash: 'aabb',
      hash: 'ccdd'
    };
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: [sample] } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.listReprisalFeed();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([sample]);
    expect(calls[0]?.body).toEqual({ op: 'feed' });
  });

  it('listReprisalFeed surfaces 403 rls_denied for a non-active-member caller', async () => {
    const { transport } = mockTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = new SupabaseReprisalClient({ transport });
    const r = await client.listReprisalFeed();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
  });
});
