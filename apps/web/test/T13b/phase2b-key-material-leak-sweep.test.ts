/**
 * Phase 2b PR1 / P2b-4 — full-workflow key-material + reprisal-plaintext +
 * passphrase leak sweep (ADR-0028 AC-8; threat-model §3.17 F-161 — extends the
 * §3.16 F-148 / §3.15 F-132 leak-sweep gate to the reprisal surfaces).
 *
 * **F-161 is one of the three Phase 2b PR1 must-fail-first findings.**
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * Across a real end-to-end submit → read → update → feed session, NONE of:
 *   - the 32 plaintext committee data-key bytes (hex),
 *   - the identity privkey bytes (hex),
 *   - the plaintext reprisal title / body strings,
 *   - the intake.passphrase string (credential-class — F-161),
 * MUST appear in any of:
 *   - console.log / console.warn / console.error,
 *   - thrown error .message / .stack,
 *   - the structured-log capture surface (__getCapturedLines),
 *   - sessionStorage / localStorage,
 *   - the URL (location.href / hash / search).
 *
 * Plus the no-serialization invariant (F-146 reused): the data key is never
 * readable from sessionStorage / localStorage at any point.
 *
 * Mirrors apps/web/test/T08/phase2a-key-material-leak-sweep.test.ts, extended
 * to the reprisal title/body + the per-record passphrase.
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
  SupabaseReprisalClient,
  type ReprisalOpTransport
} from '../../src/lib/reprisal/supabase-reprisal-client';
// RED-FIRST imports — implementer adds the compositions + re-exports.
import {
  listReprisalFeedViaProduction,
  readReprisalViaProduction,
  submitReprisalViaProduction,
  updateReprisalViaProduction
} from '../../src/lib/reprisal/production-flows';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a';

const CANARY_TITLE = 'REPRISAL-LEAKSWEEP-TITLE-PLAINTEXT-Q1';
const CANARY_BODY = 'REPRISAL-LEAKSWEEP-BODY-PLAINTEXT-Q2';
const CANARY_PASSPHRASE = 'REPRISAL-LEAKSWEEP-PASSPHRASE-Q3';

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
  liveWrap: Uint8Array | null;
}
function makeT07Transport(srv: FakeKeyServer): T07OpTransport {
  return async (body) => {
    if (body.op === 'committee_key_state') {
      return {
        status: 200,
        body: {
          ok: true,
          data: { key_id: srv.liveKeyId, epoch: srv.liveEpoch, wrap_count: 1, actor_has_wrap: true }
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

describe('Phase 2b PR1 — full-workflow leak sweep (AC-8 / F-161)', () => {
  it('data key + identity privkey + reprisal title/body + intake.passphrase NEVER appear in console / structured log / storage / URL across submit + read + update + feed', async () => {
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

    const localIdentity = silentStore();
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const dataKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const srv: FakeKeyServer = {
      liveKeyId: 'k-live-1',
      liveEpoch: 3,
      liveWrap: sodium.crypto_box_seal(dataKey, kp.publicKey)
    };
    const t07Client = new SupabaseT07Client({ transport: makeT07Transport(srv), localIdentity });
    const keyHolder = new CommitteeKeyHolder();

    const reprisalResponses: Array<{ status: number; body: unknown }> = [
      // submit
      { status: 200, body: { ok: true, data: { id: 'r-leaksweep' } } },
      // read — the stored ct decrypts to the title/body canaries
      {
        status: 200,
        body: {
          ok: true,
          data: { title_ct: sealHex(CANARY_TITLE, dataKey), body_ct: sealHex(CANARY_BODY, dataKey) }
        }
      },
      // update
      { status: 200, body: { ok: true, data: null } },
      // feed
      { status: 200, body: { ok: true, data: [] } }
    ];
    let i = 0;
    const reprisalTransport: ReprisalOpTransport = async () => {
      const r = reprisalResponses[i++];
      if (!r) throw new Error('out of reprisal responses');
      return { status: r.status, body: r.body };
    };
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisalTransport });

    // 1) Submit — feeds title/body through the seal path and the passphrase
    //    through the friction-gate forward.
    const submit = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: CANARY_TITLE, body: CANARY_BODY, passphrase: CANARY_PASSPHRASE }
    });
    expect(submit.status).toBe('ok');

    // 2) Read — feeds title/body through the open path; passphrase forwarded.
    const read = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-leaksweep',
      passphrase: CANARY_PASSPHRASE
    });
    expect(read.status).toBe('ok');

    // 3) Update — feeds the body canary through the seal path again.
    const update = await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-leaksweep',
      body: CANARY_BODY
    });
    expect(update.status).toBe('ok');

    // 4) Feed — no key/plaintext in play, but swept for completeness.
    const feed = await listReprisalFeedViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(feed.status).toBe('ok');

    const dataKeyHex = sodium.to_hex(dataKey);
    const privKeyHex = sodium.to_hex(kp.privateKey);

    const haystacks: string[] = [
      ...errs,
      ...warns,
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];

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
      expect(h).not.toContain(CANARY_PASSPHRASE);
    }
  });

  it('the intake.passphrase NEVER lands in any log surface even on a failure branch (credential-class, F-161/F-164)', async () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => errs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => warns.push(a.map(String).join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    const localIdentity = silentStore();
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const dataKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const srv: FakeKeyServer = {
      liveKeyId: 'k-live-1',
      liveEpoch: 3,
      liveWrap: sodium.crypto_box_seal(dataKey, kp.publicKey)
    };
    const t07Client = new SupabaseT07Client({ transport: makeT07Transport(srv), localIdentity });
    const keyHolder = new CommitteeKeyHolder();

    // submit fails with a 403 — assert the passphrase still never leaks.
    const reprisalTransport: ReprisalOpTransport = async () => ({
      status: 403,
      body: { ok: false, error: 'rls_denied' }
    });
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisalTransport });

    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', passphrase: CANARY_PASSPHRASE }
    });
    expect(r.status).toBe('rls_denied');

    const haystacks = [
      ...errs,
      ...warns,
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l)),
      JSON.stringify(r)
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(CANARY_PASSPHRASE);
    }
  });

  it('a decrypt failure on the read path surfaces a typed failure, never a thrown raw exception carrying buffer bytes (F-148/F-161/F-167 carry-forward)', async () => {
    const localIdentity = silentStore();
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const dataKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const srv: FakeKeyServer = {
      liveKeyId: 'k-live-1',
      liveEpoch: 3,
      liveWrap: sodium.crypto_box_seal(dataKey, kp.publicKey)
    };
    const t07Client = new SupabaseT07Client({ transport: makeT07Transport(srv), localIdentity });
    const keyHolder = new CommitteeKeyHolder();
    keyHolder.set({ data_key: dataKey, key_id: 'k-live-1', epoch: 3 });

    const reprisalTransport: ReprisalOpTransport = async () => ({
      status: 200,
      body: { ok: true, data: { title_ct: '\\xdeadbeef', body_ct: '\\xdeadbeef' } }
    });
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisalTransport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-bad',
      passphrase: null
    }).catch((e: unknown) => {
      throw new Error(
        `read must not throw on a decrypt failure; got ${e instanceof Error ? e.constructor.name : 'unknown'}`
      );
    });
    expect(r.status).not.toBe('ok');
    for (const v of Object.values(r as Record<string, unknown>)) {
      expect(v instanceof Uint8Array).toBe(false);
    }
  });
});
