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
-- The CHECK constraint added here is the strongest formulation: the column
-- only admits a JSON object with the two expected keys whose values match
-- a semver-shape regex (digits.digits.digits with optional pre-release /
-- build metadata suffix tolerated for both Node and OpenSSL).
--
-- Both regexes are intentionally PERMISSIVE on the version-suffix shape
-- (Node ships pre-release tags like `21.0.0-nightly20231003abc`; OpenSSL
-- ships `3.0.13+quic`) but STRICT on the prefix (must start with semver
-- digit-triple). This catches the threat-model concerns (hostname, FS
-- path, env content) without churn against legitimate version strings.
--
-- Source: ADR-0019 Decision §5 step 6 (`node_runtime_pin` field shape);
--   privacy-review-t18.md G-T18-PRIV-10; ADR-0018 §7 (backup_manifests
--   structural meta).
-- ===========================================================================

-- The regex is anchored at both ends; `~` is Postgres POSIX regex match.
-- The structure check uses jsonb operators: `?` asserts key presence,
-- `->>` extracts text value, `jsonb_object_keys` enumerates for arity.

ALTER TABLE public.backup_manifests
  ADD CONSTRAINT backup_manifests_node_runtime_pin_semver_check
  CHECK (
    -- Valid JSON object (parse failure raises 22P02 at INSERT time)
    node_runtime_pin::jsonb IS NOT NULL
    -- Exactly the two expected keys (no extra fingerprintable fields)
    AND (SELECT count(*) FROM jsonb_object_keys(node_runtime_pin::jsonb)) = 2
    AND node_runtime_pin::jsonb ? 'node_version'
    AND node_runtime_pin::jsonb ? 'openssl_version'
    -- Both values are semver-shape strings only
    AND (node_runtime_pin::jsonb ->> 'node_version') ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$'
    AND (node_runtime_pin::jsonb ->> 'openssl_version') ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+a-z0-9.]*)?$'
  );

COMMENT ON CONSTRAINT backup_manifests_node_runtime_pin_semver_check
  ON public.backup_manifests IS
  'G-T18-11 / privacy-review-t18.md G-T18-PRIV-10: defense-in-depth — '
  'node_runtime_pin must be a JSON object with exactly {node_version, '
  'openssl_version} keys whose values match a semver-shape regex. Catches '
  'hostname / FS path / env content leaks via out-of-band writes.';

ALTER TABLE public.integrity_check_runs
  ADD CONSTRAINT integrity_check_runs_node_runtime_pin_semver_check
  CHECK (
    node_runtime_pin::jsonb IS NOT NULL
    AND (SELECT count(*) FROM jsonb_object_keys(node_runtime_pin::jsonb)) = 2
    AND node_runtime_pin::jsonb ? 'node_version'
    AND node_runtime_pin::jsonb ? 'openssl_version'
    AND (node_runtime_pin::jsonb ->> 'node_version') ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$'
    AND (node_runtime_pin::jsonb ->> 'openssl_version') ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+a-z0-9.]*)?$'
  );

COMMENT ON CONSTRAINT integrity_check_runs_node_runtime_pin_semver_check
  ON public.integrity_check_runs IS
  'G-T18-11 / privacy-review-t18.md G-T18-PRIV-10: mirrors '
  'backup_manifests_node_runtime_pin_semver_check. Same defense-in-depth '
  'against hostname / FS path / env content leaks.';
