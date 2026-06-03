/**
 * auth-op shared types — mirror the AuthStore-side row shapes so the
 * Edge Function and the browser-side `SupabaseAuthStore` agree on the
 * wire-level structure.
 *
 * Drift between this file and `apps/web/src/lib/auth/store.ts` would
 * silently mis-decode RPC results. The browser-side test surface
 * (`apps/web/test/T05/supabase-auth-store.test.ts`) re-asserts the
 * field set; a CI drift-check could be added later if the shapes
 * grow.
 */

export interface UserRow {
  id: string;
  totp_destroyed_at: number | null;
  role?: string;
  active: boolean;
}
