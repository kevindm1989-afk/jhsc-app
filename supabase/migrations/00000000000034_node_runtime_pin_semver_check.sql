-- ===========================================================================
-- M3 / T17.1 + T18.1 / G-T18-11 — node_runtime_pin semver-shape CHECK
--
-- Defense-in-depth column constraint on `node_runtime_pin` text fields in
-- both `backup_manifests` (migration #020) and `integrity_check_runs`
-- (migration #021). The application stores a JSON-stringified shape:
--
--   { "node_version": "<semver>", "openssl_version": "<openssl-version>" }
--
-- The TS callers serialize a structured `{node_version, openssl_version}`
-- object and the read paths parse it back; the columns are stored as text
-- with no schema-level shape guard until this migration.
--
-- privacy-review-t18.md G-T18-PRIV-10 flagged `node_runtime_pin` as NOT
-- PI but fingerprintable platform metadata. The asked-for defense is a
-- column-level assertion that values are semver-shape only — i.e., no
-- hostname, no FS path, no env content leaks in via an out-of-band write.
--
-- PostgreSQL CHECK constraints cannot contain subqueries directly, so the
-- shape predicate lives in an IMMUTABLE SQL function that the CHECK
-- invokes scalar-wise. The function body uses `jsonb_object_keys()` (a
-- set-returning function) inside a subquery to enforce the exactly-two-key
-- arity — that's permitted inside a function body even though it would be
-- rejected at the top level of a CHECK expression.
--
-- Source: ADR-0019 Decision §5 step 6 (`node_runtime_pin` field shape);
--   privacy-review-t18.md G-T18-PRIV-10; ADR-0018 §7 (backup_manifests
--   structural meta).
-- ===========================================================================

-- Shape predicate function. STRICT → NULL input returns NULL (CHECK then
-- fails on NULL inputs, which is what we want; the column is NOT NULL
-- anyway, so this only matters for defense-in-depth against future column
-- nullability drift). IMMUTABLE → safe to call from CHECK + index expr.
-- PARALLEL SAFE → no side effects, can run on parallel workers.

CREATE OR REPLACE FUNCTION public.is_valid_node_runtime_pin(p_text text)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  STRICT
  PARALLEL SAFE
AS $$
  SELECT
    -- Valid JSON object (parse failure raises 22P02 inside the cast;
    -- the surrounding CHECK then propagates as a constraint violation).
    jsonb_typeof(p_text::jsonb) = 'object'
    -- Exactly the two expected keys (no extra fingerprintable fields).
    AND (SELECT count(*) FROM jsonb_object_keys(p_text::jsonb)) = 2
    AND p_text::jsonb ? 'node_version'
    AND p_text::jsonb ? 'openssl_version'
    -- Both values are semver-shape strings only. The prefix is strict
    -- (digit-triple); the suffix is permissive to admit Node pre-release
    -- tags (`21.0.0-nightly20231003abc`) and OpenSSL build metadata
    -- (`3.0.13+quic`). The threat-model concerns (hostname, FS path,
    -- env content) all fail the digit-triple prefix.
    AND (p_text::jsonb ->> 'node_version') ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$'
    AND (p_text::jsonb ->> 'openssl_version') ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+a-z0-9.]*)?$'
$$;

COMMENT ON FUNCTION public.is_valid_node_runtime_pin(text) IS
  'G-T18-11 / privacy-review-t18.md G-T18-PRIV-10: defense-in-depth shape '
  'predicate for node_runtime_pin text columns. Returns true iff the value '
  'is a JSON object with exactly {node_version, openssl_version} keys whose '
  'values match a semver-shape regex. Invoked from CHECK constraints on '
  'backup_manifests and integrity_check_runs.';

ALTER TABLE public.backup_manifests
  ADD CONSTRAINT backup_manifests_node_runtime_pin_semver_check
  CHECK (public.is_valid_node_runtime_pin(node_runtime_pin));

COMMENT ON CONSTRAINT backup_manifests_node_runtime_pin_semver_check
  ON public.backup_manifests IS
  'G-T18-11: enforces is_valid_node_runtime_pin() on the node_runtime_pin '
  'text column. Catches hostname / FS path / env content leaks via '
  'out-of-band writes.';

ALTER TABLE public.integrity_check_runs
  ADD CONSTRAINT integrity_check_runs_node_runtime_pin_semver_check
  CHECK (public.is_valid_node_runtime_pin(node_runtime_pin));

COMMENT ON CONSTRAINT integrity_check_runs_node_runtime_pin_semver_check
  ON public.integrity_check_runs IS
  'G-T18-11: mirrors backup_manifests_node_runtime_pin_semver_check. Same '
  'defense-in-depth.';
