/**
 * Phase 2a PR2 / P2a-10 — full-workflow key-material + concern-plaintext
 * leak sweep (ADR-0027 AC-9; threat-model §3.16 F-148; extends the §3.15
 * F-132 / Phase 0a sweep).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * Across a real end-to-end submit → list → reveal session:
 *   - the 32 plaintext committee data-key bytes,
 *   - the identity privkey bytes (hex),
 *   - the plaintext concern title / body / source-name strings,
 * MUST NEVER appear in any of:
 *   - `console.log` / `console.warn` / `console.error`,
 *   - thrown error `.message` / `.stack`,
 *   - the structured-log capture surface (`__getCapturedLines`),
 *   - sessionStorage / localStorage,
 *   - the URL (location.href / hash / search).
 *
 * Mirrors and extends the unwrap-only leak sweep in
 * `apps/web/test/T07/phase2a-unwrap-composition.test.ts` to ALSO cover the
 * concern plaintexts (title/body/source-name) that the three PR2
 * compositions handle.
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
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a';

const CANARY_TITLE = 'LEAKSWEEP-CANARY-TITLE-PLAINTEXT-Q1';
const CANARY_BODY = 'LEAKSWEEP-CANARY-BODY-PLAINTEXT-Q2';
const CANARY_SOURCE = 'LEAKSWEEP-CANARY-SOURCE-NAME-Q3';

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

function sealHex(pt: string, key: Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ptBytes = new Uint8Array(Buffer.from(pt, 'utf8'));
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
  plaintextKey: Uint8Array | null;
}
function newServer(): FakeKeyServer {
  return {
    liveKeyId: 'k-live-1',
    liveEpoch: 3,
    actorHasWrap: true,
    liveWrap: null,
    plaintextKey: null
  };
}
function seedWrap(srv: FakeKeyServer, pub: Uint8Array): Uint8Array {
  const plaintext = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  srv.plaintextKey = plaintext;
  srv.liveWrap = sodium.crypto_box_seal(plaintext, pub);
  return plaintext;
}
function makeT07Transport(srv: FakeKeyServer): T07OpTransport {
  return async (body) => {
    if (body.op === 'committee_key_state') {
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            key_id: srv.liveKeyId,
            epoch: srv.liveEpoch,
            wrap_count: 1,
            actor_has_wrap: true
          }
        }
      };
    }
    if (body.op === 'get_key_wrap') {
      return {
        status: 200,
        body: {
          ok: true,
          data: srv.liveWrap
            ? {
                key_id: srv.liveKeyId,
                epoch: srv.liveEpoch,
                wrapped_ciphertext_hex: bytesToPgHex(srv.liveWrap)
              }
            : null
        }
      };
    }
    throw new Error(`unexpected op ${String(body.op)}`);
  };
}

beforeEach(() => {
  __resetCapture();
  __setTestSink();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  __resetCapture();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.restoreAllMocks();
});

describe('Phase 2a PR2 — full-workflow leak sweep (AC-9 / F-148)', () => {
  it('plaintext data key + identity privkey + plaintext title/body/source NEVER appear in console / structured log / storage / URL across submit + list + reveal', async () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => {
      errs.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warns.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });

    const srv = newServer();
    const t07Transport = makeT07Transport(srv);
    const localIdentity = silentStore();
    const t07Client = new SupabaseT07Client({ transport: t07Transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const dataKey = seedWrap(srv, kp.publicKey);
    const keyHolder = new CommitteeKeyHolder();

    const concernResponses: Array<{ status: number; body: unknown }> = [
      // submit response
      { status: 200, body: { ok: true, data: { id: 'c-leaksweep' } } },
      // list response — the seeded row's title/body decrypt to canaries
      {
        status: 200,
        body: {
          ok: true,
          data: [
            {
              id: 'c-leaksweep',
              title_ct: sealHex(CANARY_TITLE, dataKey),
              body_ct: sealHex(CANARY_BODY, dataKey),
              hazard_class: 'physical',
              severity: 'low',
              location_id: 'L',
              created_at: new Date().toISOString(),
              actor_pseudonym: 'p',
              anonymous_default_kept: false,
              has_named_source: true
            }
          ]
        }
      },
      // reveal response — source_name_ct decrypts to the source canary
      {
        status: 200,
        body: { ok: true, data: { source_name_ct: sealHex(CANARY_SOURCE, dataKey) } }
      }
    ];
    let i = 0;
    const concernTransport: ConcernOpTransport = async () => {
      const r = concernResponses[i++];
      if (!r) throw new Error('out of concern responses');
      return { status: r.status, body: r.body };
    };
    const concernClient = new SupabaseConcernClient({ transport: concernTransport });

    // 1) Submit — feeds the title/body canaries through the seal path.
    await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: CANARY_TITLE,
        body: CANARY_BODY,
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L',
        anonymous: false,
        source_name_plaintext: CANARY_SOURCE
      }
    });

    // 2) List — feeds the canaries through the open path on every row.
    const list = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(list.status).toBe('ok');

    // 3) Reveal — feeds the source canary through the open path.
    const reveal = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-leaksweep',
      passphrase: null
    });
    expect(reveal.status).toBe('ok');

    const dataKeyHex = sodium.to_hex(dataKey);
    const privKeyHex = sodium.to_hex(kp.privateKey);

    const haystacks: string[] = [
      ...errs,
      ...warns,
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];

    // Storage scan.
    if (typeof sessionStorage !== 'undefined') {
      let blob = '';
      for (let j = 0; j < sessionStorage.length; j++) {
        const k = sessionStorage.key(j);
        if (k === null) continue;
        blob += k + '=' + (sessionStorage.getItem(k) ?? '') + ';';
      }
      haystacks.push(blob);
    }
    if (typeof localStorage !== 'undefined') {
      let blob = '';
      for (let j = 0; j < localStorage.length; j++) {
        const k = localStorage.key(j);
        if (k === null) continue;
        blob += k + '=' + (localStorage.getItem(k) ?? '') + ';';
      }
      haystacks.push(blob);
    }

    // URL scan.
    if (typeof window !== 'undefined' && window.location) {
      haystacks.push(window.location.href);
      haystacks.push(window.location.hash);
      haystacks.push(window.location.search);
    }

    for (const h of haystacks) {
      expect(h).not.toContain(dataKeyHex);
      expect(h).not.toContain(privKeyHex);
      expect(h).not.toContain(CANARY_TITLE);
      expect(h).not.toContain(CANARY_BODY);
      expect(h).not.toContain(CANARY_SOURCE);
    }
  });

  it('a decrypt failure on the list path (corrupt ciphertext) surfaces a typed failure, never a thrown raw exception carrying buffer bytes (F-147 / F-148 carry-forward)', async () => {
    const srv = newServer();
    const t07Transport = makeT07Transport(srv);
    const localIdentity = silentStore();
    const t07Client = new SupabaseT07Client({ transport: t07Transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    seedWrap(srv, kp.publicKey);
    const keyHolder = new CommitteeKeyHolder();

    const concernTransport: ConcernOpTransport = async () => ({
      status: 200,
      body: {
        ok: true,
        data: [
          {
            id: 'c-bad',
            title_ct: '\\xdeadbeef', // way too short — open will fail
            body_ct: '\\xdeadbeef',
            hazard_class: 'physical',
            severity: 'low',
            location_id: 'L',
            created_at: new Date().toISOString(),
            actor_pseudonym: 'p',
            anonymous_default_kept: true,
            has_named_source: false
          }
        ]
      }
    });
    const concernClient = new SupabaseConcernClient({ transport: concernTransport });
    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    }).catch((e: unknown) => {
      throw new Error(
        `list must not throw on a decrypt failure; got: ${e instanceof Error ? e.constructor.name : 'unknown'}`
      );
    });
    // The list composition must surface a typed failure rather than throw a
    // raw libsodium error that could leak buffer bytes in its message/stack.
    expect(r.status).not.toBe('ok');
    if (r.status !== 'ok') {
      // The failure surface MUST NOT contain Uint8Array values.
      for (const v of Object.values(r as Record<string, unknown>)) {
        expect(v instanceof Uint8Array).toBe(false);
      }
    }
  });
});
