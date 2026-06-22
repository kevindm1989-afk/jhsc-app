/**
 * Phase 2a PR2 / P2a-8 — worker-without-Phase-0a guard (ADR-0027 Decision 7 +
 * AC-7; threat-model §3.16 F-144 probe-first).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * The CONTRACT: every PR2 composition (submit, list, reveal) MUST consult the
 * cheap state probe (`getCommitteeKeyState`) FIRST. If the actor has no live-
 * key wrap, the composition SHORT-CIRCUITS to `{ status: 'needs_setup' }` and
 *   - does NOT call the disclosure RPC (`get_key_wrap`), and
 *   - does NOT call the concern-op transport at all.
 *
 * This pins F-144's "the disclosure RPC is NOT hit for a member with no wrap"
 * invariant at the production-composition layer (not just at the unwrap
 * composition tested in PR1).
 *
 * TEST → AC / FINDING MAP
 *   AC-7 / F-144 — submit / list / reveal short-circuit to needs_setup when
 *                  actor_has_wrap === false; the disclosure RPC + concern-op
 *                  are NEVER reached.
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
// RED-FIRST imports — implementer adds the compositions + re-exports.
import {
  submitConcernViaProduction,
  listConcernsViaProduction,
  revealConcernSourceViaProduction
} from '../../src/lib/concerns';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;

const USER = '9f4e9b40-0000-4000-8000-00000000001a';

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

function makeT07TransportNoWrap(): { transport: T07OpTransport; ops: string[] } {
  const ops: string[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
    if (body.op === 'committee_key_state') {
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            key_id: 'k-live-1',
            epoch: 3,
            wrap_count: 0,
            actor_has_wrap: false
          }
        }
      };
    }
    if (body.op === 'get_key_wrap') {
      throw new Error(
        'AC-7 / F-144 violation: get_key_wrap was called even though the probe said actor_has_wrap=false'
      );
    }
    throw new Error(`unexpected op ${String(body.op)}`);
  };
  return { transport, ops };
}

function makeNoCallConcernTransport(): {
  transport: ConcernOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const transport: ConcernOpTransport = async (body) => {
    bodies.push(body);
    throw new Error(
      `AC-7 / F-144 violation: concern-op was called (${String(body.op)}) for a no-wrap actor`
    );
  };
  return { transport, bodies };
}

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

describe('Phase 2a PR2 — worker-without-Phase-0a guard (AC-7 / F-144)', () => {
  it('submitConcernViaProduction with actor_has_wrap=false ⇒ needs_setup; disclosure RPC + concern-op NEVER called', async () => {
    const { transport: t07Transport, ops } = makeT07TransportNoWrap();
    const localIdentity = silentStore();
    const t07Client = new SupabaseT07Client({ transport: t07Transport, localIdentity });
    const concern = makeNoCallConcernTransport();
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    const keyHolder = new CommitteeKeyHolder();

    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 't',
        body: 'b',
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L',
        anonymous: true
      }
    });
    expect(r.status).toBe('needs_setup');
    expect(ops).not.toContain('get_key_wrap');
    expect(concern.bodies.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);
  });

  it('listConcernsViaProduction with actor_has_wrap=false ⇒ needs_setup; disclosure RPC + concern-op NEVER called', async () => {
    const { transport: t07Transport, ops } = makeT07TransportNoWrap();
    const localIdentity = silentStore();
    const t07Client = new SupabaseT07Client({ transport: t07Transport, localIdentity });
    const concern = makeNoCallConcernTransport();
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    const keyHolder = new CommitteeKeyHolder();

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('needs_setup');
    expect(ops).not.toContain('get_key_wrap');
    expect(concern.bodies.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);
  });

  it('revealConcernSourceViaProduction with actor_has_wrap=false ⇒ needs_setup; disclosure RPC + concern-op NEVER called', async () => {
    const { transport: t07Transport, ops } = makeT07TransportNoWrap();
    const localIdentity = silentStore();
    const t07Client = new SupabaseT07Client({ transport: t07Transport, localIdentity });
    const concern = makeNoCallConcernTransport();
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    const keyHolder = new CommitteeKeyHolder();

    const r = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-x',
      passphrase: null
    });
    expect(r.status).toBe('needs_setup');
    expect(ops).not.toContain('get_key_wrap');
    expect(concern.bodies.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);
  });
});
