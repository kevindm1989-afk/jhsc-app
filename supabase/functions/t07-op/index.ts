/**
 * t07-op — Edge Function handler (T07.1 increment 2; mirrors t14-op).
 *
 * Adapter-static, so this is an Edge Function (not a +server.ts). Builds a
 * JWT-bound supabase client; the T07.1 RPCs run as the caller's auth.uid()
 * and gate authz (session-live, active member, co-chair) internally. All key
 * material is client-sealed (ADR-0003 Invariant 1).
 *
 * Dispatch by op:
 *   enroll_identity | store_recovery | record_restored | record_viewed |
 *   issue_reset     | init_key       | wrap_member     | record_unwrap  |
 *   rotate          | finalize_rotate| revoke_member
 *
 * Deferred to subsequent T07.1 increments (per the keystone PR plan):
 *   - F-02 sealed-box enrollment challenge (G-T07-9)
 *   - SupabaseKeyStore (G-T07-2) + KeyStore interface split (G-T07-10/15)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { assertSessionLive, SessionNotLiveError } from '../_shared/session-live-precheck.ts';
import { serveWithCors } from '../_shared/cors.ts';
import _sodium from 'npm:libsodium-wrappers-sumo@0.7.15';
import { log, withFunctionName } from '../_shared/log.ts';
import { assertKeyParity, KeyParityError } from '../_shared/key-parity-fetcher.ts';
import {
  committeeKeyState,
  enrollIdentityKeypair,
  finalizeCommitteeDataKeyRotation,
  getCommitteeKeyWrapForSelf,
  getRecoveryBlob,
  initCommitteeDataKey,
  issueEnrollmentChallenge,
  issueRecoveryBlobReset,
  recordCommitteeDataKeyUnwrap,
  recordIdentitySelftestFail,
  recordPanicWipeInvoked,
  recordRecoveryBlobRestored,
  recordRecoveryBlobViewed,
  revokeCommitteeMember,
  rotateCommitteeDataKey,
  storeRecoveryBlob,
  verifyAndEnrollIdentityKeypair,
  wrapCommitteeDataKeyForMember,
  type OpResult,
  type RotationTrigger,
  type RpcPort
} from './core.ts';

withFunctionName('t07-op');

type Op =
  | { op: 'enroll_identity'; public_key_hex: string; pubkey_fingerprint: string }
  // F-02 sealed-box enrollment challenge (G-T07-9).
  | {
      op: 'enrollment_challenge_init';
      public_key_hex: string;
      pubkey_fingerprint: string;
      ttl_minutes?: number;
    }
  | { op: 'enrollment_challenge_finalize'; challenge_id: string; unsealed_nonce_hex: string }
  | { op: 'store_recovery'; blob_ciphertext_hex: string; kdf_params: Record<string, unknown> }
  | { op: 'record_restored'; device_fingerprint_hashed: string }
  | { op: 'record_viewed'; enrollment_session_id: string }
  | { op: 'issue_reset'; target_user_id: string }
  | { op: 'init_key' }
  // ADR-0026 Phase 0a (P0a-2) — read-only resume probe. `actor_user_id` is
  // forwarded for symmetry with the client probe shape; authz is auth.uid().
  | { op: 'committee_key_state'; actor_user_id?: string }
  // ADR-0027 Decision 2 (P2a-2) — read the caller's OWN committee-key wrap
  // ciphertext. Read-shaped; same gate stack. No id parameter (own-wrap-only
  // is structural; F-142). The SQL fn emits the unwrap audit row
  // audit-before-return (F-151).
  | { op: 'get_key_wrap' }
  | {
      op: 'wrap_member';
      member_user_id: string;
      key_id: string;
      wrapped_ciphertext_hex: string;
      rotation_id?: string | null;
    }
  | { op: 'record_unwrap'; key_id: string }
  | { op: 'rotate'; trigger: RotationTrigger }
  | {
      op: 'finalize_rotate';
      rotation_id: string;
      new_key_id: string;
      members_rewrapped_count: number;
    }
  | { op: 'revoke_member'; removed_member_id: string; rotation_id: string }
  | { op: 'record_selftest_fail'; meta?: Record<string, unknown> }
  | { op: 'get_recovery_blob' }
  | { op: 'record_panic_wipe'; meta?: Record<string, unknown> };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * Convert a PostgREST-friendly bytea hex string (`\x...`) into the raw
 * Uint8Array libsodium needs. Returns null on shape mismatch (the SQL
 * function will reject the value with `invalid_pubkey` separately, so we
 * collapse to a 422 bad_request before even calling Postgres).
 */
function pgHexToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string') return null;
  const stripped = s.startsWith('\\x') ? s.slice(2) : s;
  if (stripped.length === 0 || stripped.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(stripped)) return null;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

let _sodiumReady: Promise<typeof _sodium> | null = null;
function sodiumReady(): Promise<typeof _sodium> {
  if (!_sodiumReady) {
    _sodiumReady = _sodium.ready.then(() => _sodium);
  }
  return _sodiumReady;
}

serveWithCors(async (req) => {
  const requestId = req.headers.get('X-Request-ID') ?? undefined;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ADR-0024 §2 — cold-start HMAC pseudonym key parity check.
  try {
    await assertKeyParity();
  } catch (e) {
    if (e instanceof KeyParityError) {
      log.error({ event: 't07.key_parity.fail', outcome: 'mismatch' });
      return json({ error: 'service_unavailable' }, 503);
    }
    throw e;
  }

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return json({ error: 'rls_denied' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } }
  );

  // F-116 / ADR-0023 Amendment A — dispatcher-side session_is_live precheck.
  try {
    await assertSessionLive(async () => {
      const { data, error } = await supabase.rpc('session_is_live');
      return !error && data === true;
    });
  } catch (e) {
    if (e instanceof SessionNotLiveError) {
      return json({ error: 'rls_denied' }, 401);
    }
    throw e;
  }

  const rpc: RpcPort = async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    return {
      data,
      error: error
        ? { code: (error as { code?: string }).code ?? null, message: error.message }
        : null
    };
  };

  let body: Op;
  try {
    body = (await req.json()) as Op;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  let result: OpResult<unknown>;
  switch (body.op) {
    case 'enroll_identity':
      result = await enrollIdentityKeypair(rpc, body);
      break;
    case 'enrollment_challenge_init': {
      // F-02 (G-T07-9): Edge Function generates a fresh random nonce, stores
      // HMAC(nonce) server-side, seals the raw nonce to the posted pubkey,
      // and returns the SEALED nonce to the client. The client unseals with
      // its device-local private key and posts it back to ..._finalize.
      const pubkey = pgHexToBytes(body.public_key_hex);
      if (!pubkey || pubkey.length !== 32) {
        return json({ ok: false, error: 'invalid_input' }, 422);
      }
      const sodium = await sodiumReady();
      const nonce = sodium.randombytes_buf(32);
      const sealed = sodium.crypto_box_seal(nonce, pubkey);
      const issued = await issueEnrollmentChallenge(rpc, {
        public_key_hex: body.public_key_hex,
        pubkey_fingerprint: body.pubkey_fingerprint,
        raw_nonce_hex: bytesToPgHex(nonce),
        ttl_minutes: body.ttl_minutes ?? 10
      });
      if (!issued.ok) {
        result = issued;
        break;
      }
      // The raw nonce never leaves this function in cleartext — only the
      // sealed-box ciphertext does. The client unseals with the local
      // privkey, proving possession (F-02).
      result = {
        ok: true,
        data: { challenge_id: issued.data.challenge_id, sealed_nonce_hex: bytesToPgHex(sealed) }
      };
      break;
    }
    case 'enrollment_challenge_finalize':
      result = await verifyAndEnrollIdentityKeypair(rpc, {
        challenge_id: body.challenge_id,
        raw_nonce_observed_hex: body.unsealed_nonce_hex
      });
      break;
    case 'store_recovery':
      result = await storeRecoveryBlob(rpc, body);
      break;
    case 'record_restored':
      result = await recordRecoveryBlobRestored(rpc, body);
      break;
    case 'record_viewed':
      result = await recordRecoveryBlobViewed(rpc, body);
      break;
    case 'issue_reset':
      result = await issueRecoveryBlobReset(rpc, body);
      break;
    case 'init_key':
      result = await initCommitteeDataKey(rpc);
      break;
    case 'committee_key_state':
      result = await committeeKeyState(rpc);
      break;
    case 'get_key_wrap':
      result = await getCommitteeKeyWrapForSelf(rpc);
      break;
    case 'wrap_member':
      result = await wrapCommitteeDataKeyForMember(rpc, body);
      break;
    case 'record_unwrap':
      result = await recordCommitteeDataKeyUnwrap(rpc, body);
      break;
    case 'rotate':
      result = await rotateCommitteeDataKey(rpc, body);
      break;
    case 'finalize_rotate':
      result = await finalizeCommitteeDataKeyRotation(rpc, body);
      break;
    case 'revoke_member':
      result = await revokeCommitteeMember(rpc, body);
      break;
    case 'record_selftest_fail':
      result = await recordIdentitySelftestFail(rpc, body);
      break;
    case 'get_recovery_blob':
      result = await getRecoveryBlob(rpc);
      break;
    case 'record_panic_wipe':
      result = await recordPanicWipeInvoked(rpc, body);
      break;
    default:
      return json({ ok: false, error: 'bad_request' }, 400);
  }

  log.info({
    event: 't07.op',
    attributes: { route: body.op, outcome: result.ok ? 'ok' : result.reason },
    request_id: requestId
  });
  if (result.ok) return json({ ok: true, data: result.data }, 200);
  return json({ ok: false, error: result.reason }, result.status);
});
