# Structured logging contract

> Phase-0 spec. The implementer of T02 wires this into
> `apps/web/src/lib/log/` (browser + server) and
> `supabase/functions/_shared/log.ts` (Edge Functions).
>
> Sources:
> - `.context/constraints.md` "Logging hygiene"
> - `.context/decisions.md` ADR-0010 (Sentry — scrubber co-lives with logger)
> - `.context/threat-model.md` §3.1 F-09 (Edge Function log scrubbing)
> - `.context/threat-model.md` §6 Invariants 1, 3, 5
> - `JHSC-APP-PLAN.md` §7 ("No PI in logs / URLs / telemetry")

This contract is the only one. Browser logs, server logs, and Edge
Function logs share the same schema and the same `safeFields` allowlist.

---

## 1. Log levels

| Level | When | In production? | Sampled? |
|---|---|---|---|
| **DEBUG** | Developer-only; high-frequency state | NO | n/a |
| **INFO** | Key business events, successful state transitions | YES | INFO **may** be sampled at 1:10 at high volume — at JHSC scale this is unnecessary; default 1:1. Sampling decision belongs to the SRE-specialist in Phase 4. |
| **WARN** | Degraded but-functioning condition (retry succeeded, rate-limit near, soft validation failure) | YES | Never |
| **ERROR** | Handled failure (the operation did not complete) | YES | Never |
| **FATAL** | Process-down / data-corrupting condition. Always paged via alert. | YES | Never |

DEBUG is build-time excluded from production bundles via a `if (DEV)`
guard. CI test asserts no `log.debug(` call survives in the
production bundle (grep on built JS).

---

## 2. Event schema (every log line)

JSON-lines, UTF-8, one event per line. Required fields are non-null
in every emission.

| Field | Type | Required | Notes |
|---|---|---|---|
| `ts` | string (ISO-8601 UTC, ms precision) | YES | `new Date().toISOString()` |
| `level` | enum (`DEBUG`/`INFO`/`WARN`/`ERROR`/`FATAL`) | YES | |
| `service` | enum (`web-browser`/`web-server`/`edge-fn:<name>`) | YES | Identifies the emitter |
| `env` | enum (`dev`/`ci`/`staging`/`prod`) | YES | |
| `release` | string (git SHA, short 7) | YES | Wired at build |
| `request_id` | string (UUIDv4) | YES on server + edge; on browser when correlating to a fetch | The correlation key across all three pillars |
| `actor_pseudonym` | string (16 hex) | YES on server/edge for any authenticated request; FORBIDDEN on browser | HMAC of supabase auth uid; server-only derivation |
| `route` | string (route shape only, e.g. `/api/concerns/:id`) | YES on server/edge | NEVER raw URL with params |
| `outcome` | enum (`ok`/`client_error`/`server_error`/`rejected`/`rate_limited`/`auth_failed`) | YES | |
| `latency_ms` | integer | YES on server/edge for request-handling events | |
| `event` | string (machine-parseable name, dot-namespaced) | YES | E.g. `auth.passkey.assert`, `concern.create`, `export.generated` |
| `error_class` | string | YES if `level >= ERROR` | The error TYPE, never the message (messages may carry PI) |
| `attributes` | object (keys MUST be on `safeFields`) | NO | Unknown keys are dropped at emit time |

### Forbidden fields (the logger silently drops them AND emits a CI WARN in test)

Anything in the PI inventory from `.context/decisions.md` §System Design:
- `display_name`, `off_employer_contact`, `email`, `phone`
- `*_ciphertext` / `*_ct` keys
- `source_name_*`, `reprisal_*`, `work_refusal_*`, `s51_*`
- auth material: `cookie`, `authorization`, `jwt`, `access_token`,
  `refresh_token`, `totp_*`, `passkey_*`, `webauthn_*`, `password`,
  `api_key`, `recovery_passphrase`
- raw identifiers: `user_id`, `auth_uid`, `sub`, `supabase_uid`
- request payloads: `body`, `payload`, `form`, `req_body`, `request_body`
- raw URLs (always pass through `scrubUrl()` first)
- IP addresses (no IP appears in app logs; Supabase platform logs are
  separate and not under app control — see `observability/README.md`
  §10 finding #2)

### `error_class` vs `error_message`

We log the **class** (`AuthFailedError`, `RlsDenied`, `RateLimited`),
never the message. Many error messages carry the user input that caused
them ("Invalid email 'real@example.com'"). The class is enough for
triage; the stack trace lives in Sentry, scrubbed.

---

## 3. The `safeFields` allowlist (browser + server + edge)

This is the closed list of keys allowed in `attributes`. Anything not
listed is dropped at emit. The implementer wires this as a TypeScript
union type, so the type-checker enforces it at compile.

### Universal (any service)

- `route` (already top-level; mirrored in attrs for ad-hoc events)
- `outcome` (already top-level; mirrored)
- `latency_ms`
- `attempt` (integer, for retry events)
- `rate_limit_key_class` (e.g. `per_user_per_minute`; NOT the key value)
- `feature_flag` (flag name only, never user-resolved value)
- `release`

### Auth (T05)

- `auth.method` (`passkey` | `totp_bootstrap`)
- `auth.result` (`success` | `failure_credential` | `failure_rate_limited` | `failure_unknown`)
- `auth.totp_consumed` (boolean — only emitted by the destroy-TOTP path)
- `auth.session_id_pseudonym` (HMAC of session id; same key as actor_pseudonym)

### Audit-log-write echo (every audit emission also writes one structured log line)

- `audit.event_type` (one of the closed enum; see `audit-log.md` §2)
- `audit.target_class` (`C0` | `C1` | `C2` | `C3` | `C4`)
- `audit.target_id_pseudonym` (HMAC of target_id when target_id is itself PI; raw enum/UUID otherwise — see `audit-log.md`)
- `audit.rotation_id` (UUID; optional, set on key-material events)

### Concern intake (T08)

- `concern.action` (`create` | `update` | `triage` | `source_reveal_attempt`)
- `concern.anonymous_default` (boolean — was the default kept?)
- `concern.hazard_class` (enum, C1)
- `concern.severity` (enum, C1)

### Inspections / sync (T10)

- `sync.entries_drained` (integer)
- `sync.entries_rejected_hmac_fail` (integer)
- `sync.queue_depth` (integer, gauge)
- `cache.policy_violation` (boolean; emitted by SW sanity check)
- `cache.allowlist_version` (string)

### Export (T11 / T12)

- `export.kind` (`minutes.final` | `recommendation`)
- `export.field_set_hash` (hex; the F-19 allowlist hash)
- `export.derived_from_concerns_count` (integer; from RA-1)
- `export.recipient_role` (enum — currently always `employer_co_chair`)

### Reprisal / C4 reads (T13 / T14)

- `c4.table` (`reprisal_log` | `work_refusal` | `s51_evidence`)
- `c4.read_via` (`security_definer_view` | `edge_function_indirection`)
- `c4.access_attempt_outcome` (`success` | `wrong_passphrase` | `denied`)

### Retention (T16)

- `retention.table` (e.g. `concerns`)
- `retention.deleted_count` (integer)
- `retention.dry_run` (boolean)

### Audit-log integrity (T18)

- `integrity.last_good_seq` (bigint)
- `integrity.first_bad_seq` (bigint, on failure only)
- `integrity.trigger` (`scheduled` | `post_rotation` | `post_export`)

### Backup / drift (T17)

- `backup.bucket` (string — the bucket NAME, fixed; not a credential)
- `backup.age_hours` (integer)
- `drift.field` (e.g. `versioning`, `object_lock_default_retention`)
- `drift.expected` (string)
- `drift.observed` (string)

---

## 4. Edge Function logging (F-09)

Edge Functions are the highest-risk logging surface: they handle
ciphertext payloads, and a careless `console.log(req)` in an Edge
Function leaks payload shape + provenance even when no plaintext.

### Hard rules

1. **No `console.log(req)`, `console.log(req.body)`, `console.log(payload)`
   anywhere in `supabase/functions/`**. Semgrep rule
   `edge-fn-no-raw-request-log` (T02 ships the semgrep file; CI fails on
   any match). Pattern includes any logger call (`console.*`,
   `log.*`, `pino`, `winston`, `bunyan`) whose argument is `req`,
   `req.body`, `payload`, or the parameter of the handler function.
2. **Every Edge Function imports the shared logger.** Direct `console.*`
   calls fail CI via a semgrep rule that allowlists only the shared
   module.
3. **Every Edge Function emits the same schema (§2).** `service` is
   `edge-fn:<name>`.
4. **`request_id` is propagated.** The browser generates UUIDv4 per
   request, sends it as the `X-Request-ID` header; the Edge Function
   uses that header if present, else generates one. Server returns the
   id in the response so the browser can log its tail of the request
   under the same id.
5. **Canary fixture for F-09** (test-writer's T02 obligation): post a
   payload containing the canary `CANARY_PII_X` through every Edge
   Function endpoint; capture Supabase function logs for that run;
   `grep` for canary; assert absent.
6. **The Edge Function logger has the same `safeFields` allowlist as
   the browser logger.** The denylist is enforced at the emit point —
   the logger does NOT trust the caller.

### Edge Function additional safety

- `try {...} catch (e) { log.error({event: 'fn.unhandled', error_class: e.constructor.name}); throw }` is the canonical
  catch shape. Never `log.error({error: e})` — `e.message` may carry PI.
- The shared `sentry-scrub.ts` (from `observability/sentry-scrub.ts`)
  is re-used here: when an Edge Function captures an exception to
  Sentry, the same `beforeSend` runs.
- Response bodies returned to clients contain NO error message text
  beyond a fixed enum (`AUTH_FAILED`, `RATE_LIMITED`, `RLS_DENIED`,
  `VALIDATION_FAILED`, `SERVER_ERROR`). The client maps the enum to
  the user-facing i18n string via T03.

---

## 5. Browser logger

- Single module: `apps/web/src/lib/log/index.ts`.
- API surface: `log.debug | log.info | log.warn | log.error | log.fatal`,
  each taking a single object `{ event, ...attributes }`.
- The same denylist runs at emit; the logger transports lines via
  POST to `/api/log/ingest` (an Edge Function) in batches of <= 50
  events with a 5-second flush — never per-event-per-fetch.
- The ingest endpoint applies the denylist AGAIN (defense in depth)
  and writes to Supabase function logs under `service: web-browser`.
- INFO is sampled 1:1 at v1 scale. The sampling knob is a single
  constant in the module; flag for the SRE-specialist when traffic
  rises.
- `log.fatal` triggers an out-of-band beacon (`navigator.sendBeacon`)
  to ensure delivery on page unload.

---

## 6. Correlation: how a Sentry event ties back to logs

```
Browser issue → Sentry event captured (PII-scrubbed) with `tags.request_id = <id>`
                                                            |
                                                            v
Server / Edge Function log line(s) with `request_id = <id>` and the matching `route`
                                                            |
                                                            v
Audit-log row (if a state change occurred) with `request_id = <id>` in its `meta` jsonb
```

The `request_id` is propagated everywhere. It is NOT itself PI (a
random UUID, not bound to any user identity). It IS the trace key the
incident-responder uses to walk an error end-to-end.

---

## 7. What CI enforces

The verifier (T00 + T02) wires these into `scripts/verify.sh`:

1. Semgrep rule `no-pi-in-log-attrs` — fails on `log.*({.., display_name|email|phone|body|password|token: ...})` literal-key patterns.
2. Semgrep rule `no-console-log-req` — fails on `console.*(req|req.body|payload|body)` in `supabase/functions/`.
3. Semgrep rule `no-direct-sentry-setuser` — bans `Sentry.setUser` on the browser path.
4. Semgrep rule `no-debug-in-prod` — bans `log.debug(` outside `dev` / `test` files.
5. Bundle-grep: built browser bundle does NOT contain `HMAC_PSEUDONYM_KEY` or any 32-byte high-entropy literal at suspicious shape.
6. Canary scrub test: see `observability/sentry-scrub.ts` §9.
7. Edge Function canary test: a synthetic POST containing canary string traverses each Edge Function path; Supabase function logs are queried for the canary; assert absent.
