/**
 * Service-role fetcher for the EF cold-start parity check (ADR-0024 §2).
 *
 * Why: `_shared/key-parity.ts` takes a `ServerShaFetcher` closure — the
 * EF supplies the function that returns the server SHA. The fetcher
 * MUST call `public.key_parity_server_sha()` against the project DB.
 * That function is granted EXECUTE to `service_role` only (per migration
 * 00000000000018), NOT to `authenticated`, because exposing the SHA
 * to authenticated callers would narrow offline brute-force per
 * threat-model.md §3.14 F-124.
 *
 * So the EF needs a service-role client just for this one call. We
 * construct it lazily and cache it per-process, mirroring the
 * memoisation in `_shared/key-parity.ts` (one call per process boot).
 *
 * Privacy invariant: the service-role key NEVER appears in logs, errors,
 * audit rows, or any other emission surface — same denylist as the
 * pseudonym key per .context/secret-inventory.md.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { assertKeyParity as _assertKeyParityCore, KeyParityError } from './key-parity.ts';

let _serviceRoleClient: SupabaseClient | null = null;

function getServiceRoleClient(): SupabaseClient {
  if (_serviceRoleClient !== null) return _serviceRoleClient;
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  _serviceRoleClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false }
  });
  return _serviceRoleClient;
}

/**
 * Cold-start parity assertion. Call once per Deno.serve invocation
 * (memoised by `_shared/key-parity.ts` after the first match). On
 * mismatch: throws KeyParityError. The dispatcher's catch path returns
 * 503 (service_unavailable — the EF process cannot serve correctly
 * under a mismatched key).
 *
 * Named `assertKeyParity` (not `assertEFKeyParity`) so the CI grep
 * scripts/verify-key-parity-import.sh matches `assertKeyParity\s*\(`
 * at the EF call site without ambiguity.
 */
export async function assertKeyParity(): Promise<void> {
  return _assertKeyParityCore(async () => {
    const sb = getServiceRoleClient();
    const { data, error } = await sb.rpc('key_parity_server_sha');
    if (error) {
      throw new Error(`key_parity_server_sha rpc failed: ${error.code ?? 'unknown'}`);
    }
    if (typeof data !== 'string') {
      throw new Error('key_parity_server_sha returned non-string');
    }
    return data;
  });
}

export { KeyParityError };

/**
 * Test-only reset — production must NEVER call this. Exposed so the
 * Deno test harness can reset the per-process service-role client.
 */
export function __resetServiceRoleClientForTests(): void {
  _serviceRoleClient = null;
}
