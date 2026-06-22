-- ===========================================================================
-- Production RLS/permission fix — `concern_list_default()` SECURITY DEFINER RPC
-- supersedes the direct `authenticated` read of `concerns_default_view`.
--
-- ROOT CAUSE (PG view-invoker-execute rule):
--   Migration 0039 widened `concerns_default_view` to project
--   `public._committee_pseudonym(c.actor_id) AS actor_pseudonym`. In
--   PostgreSQL, the INVOKER of a view must hold EXECUTE on every function the
--   view calls — even for a non-`security_invoker` (owner's-rights) view; the
--   owner's rights only cover TABLE access, not the EXECUTE check on functions
--   referenced in the query. `_committee_pseudonym(uuid)` is deliberately
--   `REVOKE ALL ... FROM PUBLIC` (migration 0002:205) and is NOT granted to
--   `authenticated` (granting it would let any member deanonymize arbitrary
--   uuids — a re-identification vector). So when concern-op's `list` does
--   `SELECT * FROM concerns_default_view` as the `authenticated` role via
--   PostgREST, PostgreSQL raises `permission denied for function
--   _committee_pseudonym` → the SELECT errors → concern-op maps it to
--   `rls_denied` (403) and the concerns list is blocked in production.
--
--   CI missed it because the pgTAP stage runs as a superuser, which can
--   execute the function; the `authenticated` role path was never exercised.
--
-- THE FIX:
--   Convert the list read into a `SECURITY DEFINER` SQL function. The body
--   (and thus the nested `_committee_pseudonym` → `private._hmac_pseudonym_key()`
--   Vault read) runs as the function OWNER — exactly like the audit_emit /
--   concern_submit path that already works on hosted. The function is granted
--   to `authenticated`, but `_committee_pseudonym` itself stays locked down.
--
--   The per-caller membership gate is PRESERVED: `auth.uid()`,
--   `session_is_live()`, and `is_active_member(auth.uid())` all read the
--   session-scoped `request.jwt.claims` GUC, which is unaffected by
--   SECURITY DEFINER (the definer switches the ROLE, not the session GUCs).
--   So each caller is still gated to live, active members and sees only the
--   rows the view would have shown them.
--
-- SHAPE: the RETURNS TABLE mirrors `concerns_default_view` (migration 0039)
--   column-for-column, in order, with the base-table types from migration
--   0004 (`hazard_class`/`severity`/`location_id` are plain `text` with CHECK
--   constraints, NOT enums) and `actor_pseudonym varchar(16)` from
--   `_committee_pseudonym`'s return type. The client `ConcernListRow` /
--   `listConcernsViaProduction` shape is therefore unchanged.
--
-- We leave `concerns_default_view` in place (harmless); the RPC is the new
-- read path for the authenticated PostgREST caller. `source_name_ct` stays
-- EXCLUDED (F-18); raw `actor_id` stays out of the projection (F-149).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.concern_list_default()
RETURNS TABLE (
  id                      uuid,
  title_ct                bytea,
  body_ct                 bytea,
  hazard_class            text,
  severity                text,
  location_id             text,
  created_at              timestamptz,
  updated_at              timestamptz,
  actor_pseudonym         varchar(16),
  anonymous_default_kept  boolean,
  has_named_source        boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    c.id,
    c.title_ct,
    c.body_ct,
    c.hazard_class,
    c.severity,
    c.location_id,
    c.created_at,
    c.updated_at,
    public._committee_pseudonym(c.actor_id) AS actor_pseudonym,
    (c.source_name_ct IS NULL)     AS anonymous_default_kept,
    (c.source_name_ct IS NOT NULL) AS has_named_source
  FROM public.concerns c
  WHERE public.session_is_live() AND public.is_active_member(auth.uid())
  ORDER BY c.created_at DESC;
$$;

-- Grants matrix mirrors the gated/audited concern functions (migration 0004):
-- closed by construction, then opened only to the PostgREST authenticated role
-- and the auth admin. We do NOT grant `_committee_pseudonym` to authenticated
-- (the deanonymization lock-down at 0002:205 is preserved) — the nested call
-- resolves under the SECURITY DEFINER owner's rights here, NOT the caller's.
REVOKE ALL ON FUNCTION public.concern_list_default() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.concern_list_default() TO authenticated, supabase_auth_admin;

COMMENT ON FUNCTION public.concern_list_default() IS
  'F-18/F-149 default concern list. SECURITY DEFINER RPC that SUPERSEDES the '
  'direct authenticated read of concerns_default_view: PostgreSQL requires the '
  'view INVOKER to hold EXECUTE on _committee_pseudonym (REVOKE''d from '
  'authenticated, 0002:205), so the direct view read raises permission-denied '
  'for the authenticated PostgREST role. Running the pseudonym derivation under '
  'the definer (owner) keeps the deanonymization lock-down intact while the '
  'session_is_live()/is_active_member(auth.uid()) gate stays per-caller via '
  'request.jwt.claims. Returns the same rows/shape concerns_default_view did.';
