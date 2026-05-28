/**
 * T08.1 — G-T08-2 SupabaseConcernClient tests.
 *
 * Hermetic: a stub `ConcernOpTransport` records the request body + returns
 * canned responses. Asserts each high-level method posts the right
 * { op, ...args } shape to the concern-op Edge Function, the bytea hex
 * encoding/decoding round-trips, and the error-mapping surface (rls_denied,
 * rate_limited, not_found, invalid_input).
 */

import { describe, expect, it } from 'vitest';
import {
  SupabaseConcernClient,
  type ConcernOpTransport,
  type ConcernListRow
} from '../../src/lib/concerns/supabase-concern-client';

function mockTransport(
  responses: Array<{ status: number; body: unknown }>
): { transport: ConcernOpTransport; calls: Array<{ body: Record<string, unknown> }> } {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport: ConcernOpTransport = async (body) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error(`mockTransport: no response queued for call #${calls.length}`);
    return r;
  };
  return { transport, calls };
}

describe('T08.1 / G-T08-2 — SupabaseConcernClient.submitConcern', () => {
  it('posts { op: submit } with bytea-hex-encoded ciphertexts + named-source fields', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { id: 'c-1' } } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.submitConcern({
      title_ct: new Uint8Array([0xde, 0xad]),
      body_ct: new Uint8Array([0xbe, 0xef]),
      hazard_class: 'physical',
      severity: 'high',
      location_id: 'L-1',
      anonymous: false,
      source_name_ct: new Uint8Array([0xca, 0xfe]),
      source_passphrase: 'hunter2'
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ id: 'c-1' });
    expect(calls[0]?.body).toEqual({
      op: 'submit',
      title_ct: '\\xdead',
      body_ct: '\\xbeef',
      hazard_class: 'physical',
      severity: 'high',
      location_id: 'L-1',
      anonymous: false,
      source_name_ct: '\\xcafe',
      source_passphrase: 'hunter2'
    });
  });

  it('forwards `anonymous: true` + `source_name_ct: null` for anonymous submissions', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { id: 'c-2' } } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    await client.submitConcern({
      title_ct: new Uint8Array([0x01]),
      body_ct: new Uint8Array([0x02]),
      hazard_class: 'biological',
      severity: 'medium',
      location_id: 'L-2',
      anonymous: true
    });
    expect(calls[0]?.body).toMatchObject({
      anonymous: true,
      source_name_ct: null,
      source_passphrase: null
    });
  });

  it('surfaces 429 rate_limited verbatim', async () => {
    const { transport } = mockTransport([
      { status: 429, body: { ok: false, error: 'rate_limited' } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.submitConcern({
      title_ct: new Uint8Array([0]),
      body_ct: new Uint8Array([0]),
      hazard_class: 'physical',
      severity: 'low',
      location_id: 'L-1',
      anonymous: true
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rate_limited');
    expect(r.status).toBe(429);
  });

  it('surfaces 403 rls_denied verbatim', async () => {
    const { transport } = mockTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.submitConcern({
      title_ct: new Uint8Array([0]),
      body_ct: new Uint8Array([0]),
      hazard_class: 'physical',
      severity: 'low',
      location_id: 'L-1',
      anonymous: true
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
    expect(r.status).toBe(403);
  });
});

describe('T08.1 / G-T08-2 — SupabaseConcernClient.updateConcern', () => {
  it('forwards only the provided patch fields (NULL omission)', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: null } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    await client.updateConcern({ id: 'c-1', body_ct: new Uint8Array([0xd0, 0x0d]) });
    expect(calls[0]?.body).toEqual({
      op: 'update',
      id: 'c-1',
      body_ct: '\\xd00d'
    });
  });

  it('passes through every field when all are present', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: null } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    await client.updateConcern({
      id: 'c-1',
      title_ct: new Uint8Array([0xaa]),
      body_ct: new Uint8Array([0xbb]),
      hazard_class: 'physical',
      severity: 'low',
      location_id: 'L-3'
    });
    expect(calls[0]?.body).toEqual({
      op: 'update',
      id: 'c-1',
      title_ct: '\\xaa',
      body_ct: '\\xbb',
      hazard_class: 'physical',
      severity: 'low',
      location_id: 'L-3'
    });
  });

  it('surfaces 404 not_found verbatim', async () => {
    const { transport } = mockTransport([
      { status: 404, body: { ok: false, error: 'not_found' } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.updateConcern({ id: 'missing', severity: 'low' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
    expect(r.status).toBe(404);
  });
});

describe('T08.1 / G-T08-2 — SupabaseConcernClient.revealConcernSource', () => {
  it('forwards id + passphrase, decodes the returned bytea hex back to Uint8Array', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { source_name_ct: '\\xcafe' } } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.revealConcernSource({ id: 'c-1', passphrase: 'hunter2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source_name_ct).toEqual(new Uint8Array([0xca, 0xfe]));
    expect(calls[0]?.body).toEqual({ op: 'reveal', id: 'c-1', passphrase: 'hunter2' });
  });

  it('returns null source_name_ct for anonymous concerns', async () => {
    const { transport } = mockTransport([
      { status: 200, body: { ok: true, data: { source_name_ct: null } } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.revealConcernSource({ id: 'c-anon' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source_name_ct).toBeNull();
  });

  it('surfaces invalid_input (e.g. wrong passphrase) as 422', async () => {
    const { transport } = mockTransport([
      { status: 422, body: { ok: false, error: 'invalid_input' } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.revealConcernSource({ id: 'c-1', passphrase: 'wrong' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid_input');
    expect(r.status).toBe(422);
  });
});

describe('T08.1 / G-T08-2 — SupabaseConcernClient.listConcerns', () => {
  it('posts { op: list } and returns the default-projection rows', async () => {
    const sample: ConcernListRow = {
      id: 'c-1',
      title_ct: '\\xdead',
      body_ct: '\\xbeef',
      hazard_class: 'physical',
      severity: 'high',
      location_id: 'L-1',
      anonymous_default_kept: true,
      created_at: '2026-05-28T00:00:00Z',
      actor_pseudonym: 'abc123def4567890'
    };
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: [sample] } }
    ]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.listConcerns();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([sample]);
    expect(calls[0]?.body).toEqual({ op: 'list' });
  });

  it('surfaces a missing body / malformed response as unknown', async () => {
    const { transport } = mockTransport([{ status: 500, body: null }]);
    const client = new SupabaseConcernClient({ transport });
    const r = await client.listConcerns();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown');
    expect(r.status).toBe(500);
  });
});
