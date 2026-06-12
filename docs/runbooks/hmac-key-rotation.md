# HMAC pseudonym key rotation runbook

**Audience:** the on-call operator authorised to handle a `$HMAC_PSEUDONYM_KEY` rotation.

**Authority:** ADR-0024 §5 (rotation atomic-swap window, HG-NEW-3 ratified 2026-06-12); ADR-0016 (HMAC pseudonymization standard); `.context/secret-inventory.md` ($HMAC_PSEUDONYM_KEY classification).

**Cadence:** annual, per ADR-0016. Off-cadence rotations only on suspected exfiltration (see §7 below).

**The hard rule (HG-NEW-3 / F-125 / F-126):** the GitHub Actions secret and the Postgres GUC `app.hmac_pseudonym_key` MUST be updated in lockstep within a single atomic-swap window. The deploy-time CI parity check (`scripts/verify-key-parity-deploy.sh`) is allowed to fail-and-retry-once before failing the deploy. **No `KEY_PARITY_SKIP`. No `--force`. No `if: false` workflow bypass.** The check fails closed. Always.

---

## §1. Prerequisites — verify BEFORE you start

- [ ] You have admin access to the GitHub repository's Actions secret store.
- [ ] You have a direct Postgres connection to the production project as a role that can `ALTER SYSTEM SET app.hmac_pseudonym_key = '...'` (typically `migration_role` or `postgres`).
- [ ] You have a *second* operator on hold to ratify the swap (HG-15 four-eyes rule for secret writes — see ADR-0007 / ADR-0010).
- [ ] No production deploy is currently in flight. If one is, **wait for it to finish** before proceeding.
- [ ] The current key's age is verified: `SELECT key_parity_server_sha()` against production returns a known SHA you can record as the "pre-rotation" SHA.
- [ ] You have read the §3 atomic-swap procedure end-to-end before executing any step.

If any of these is not true, **stop**. Do not begin the rotation. The rotation can only be safely executed inside the window where the above hold.

---

## §2. Generate the new key

```bash
# 256 bits of OS-CSPRNG entropy, hex-encoded (64 chars).
NEW_KEY="$(head -c 32 /dev/urandom | xxd -p -c 64)"

# Sanity check the length (verify-key-entropy.sh enforces the same floor):
[ "${#NEW_KEY}" -eq 64 ] || { echo "FAIL — key length is ${#NEW_KEY}, need 64"; exit 1; }
```

The new key value lives ONLY in this terminal session and in `1Password` (your personal vault, NOT a shared vault) until §3 completes. Do not echo it anywhere else. Do not paste it into a chat client. Do not copy it to a paste buffer that auto-syncs.

Compute the new key's SHA so you can verify the parity check after the swap:

```bash
NEW_SHA="$(printf '%s' "$NEW_KEY" | sha256sum | awk '{print $1}')"
echo "new SHA: $NEW_SHA"
```

Record `NEW_SHA` in your scratch notes for §4 verification. The SHA is non-secret-but-sensitive per `.context/secret-inventory.md`; do not log it to Sentry / structured logs / audit-log meta. Pen-and-paper is acceptable.

---

## §3. Atomic-swap window — execute IN ORDER, fast

The atomic-swap window is the time between updating one half (GH-Actions secret or Postgres GUC) and updating the other half. Any deploy that runs INSIDE this window will encounter a parity mismatch. Per HG-NEW-3, the CI check is allowed exactly **one 30-second retry** before failing the deploy. **Aim to complete §3 in under 30 seconds.**

### 3a. Pause CI

In the GitHub repository settings, temporarily disable the production deploy workflow (or its scheduled triggers). This prevents a deploy from racing the swap. Re-enable in §5.

### 3b. Get your second operator on the line

Voice or text — they need to see the SHA you'll record in §4 and ratify the rotation. They do NOT see the key value.

### 3c. Update the Postgres GUC FIRST

```sql
-- As migration_role (or whichever role can ALTER SYSTEM):
ALTER SYSTEM SET app.hmac_pseudonym_key = '<NEW_KEY value from §2>';
SELECT pg_reload_conf();

-- Verify within the same session:
SELECT key_parity_server_sha();   -- must equal NEW_SHA from §2
```

If the verification SHA does NOT match `NEW_SHA`: stop, do not proceed, revert with `ALTER SYSTEM RESET app.hmac_pseudonym_key; SELECT pg_reload_conf();` and start over.

### 3d. Update the GH-Actions secret SECOND

In GitHub Actions secrets, update `HMAC_PSEUDONYM_KEY` to the `NEW_KEY` value from §2.

The order matters: GUC first means a deploy that races the window sees a mismatch (deploy fails closed, operator retries after §3 completes). GH-Actions secret first would mean a deploy could complete with a mismatch.

### 3e. Clear local terminal state

```bash
unset NEW_KEY
history -c   # bash
# fish: clear the history surface for this terminal
```

The new key value should now exist in exactly two places: the GitHub Actions secret store and the Postgres GUC. Plus your 1Password vault as the recovery anchor.

---

## §4. Verify

Run the deploy-time CI check manually against production:

```bash
# Set both env vars, then invoke the script:
HMAC_PSEUDONYM_KEY=<read from 1Password> \
DEPLOY_DB_URL=<production DB URL with deploy_reader_role auth> \
bash scripts/verify-key-parity-deploy.sh
```

Expected output:
```
verify-key-parity-deploy: OK — env SHA matches server SHA (attempt 1)
```

If you see `attempt 2 / after atomic-swap wait`: the retry caught it. Fine. The deploy will pass.

If you see `FAIL — env SHA does not match server SHA (both attempts)`: **something is wrong**. Do NOT re-enable CI yet. Investigate:
- Did §3c update the GUC successfully? `SELECT key_parity_server_sha()` against production.
- Did §3d save the GH-Actions secret without trailing whitespace / pasted ANSI?
- Did you compute `NEW_SHA` correctly?

Resolve before §5.

Have your second operator on the line read `NEW_SHA` from your scratch notes; they confirm it matches what you wrote down in §2. **This is the four-eyes check** — they confirm the rotation was deliberate, not that they verify the SHA value (which would require them to know the key).

---

## §5. Re-enable CI

Re-enable the production deploy workflow / scheduled triggers in GitHub settings. The next deploy will use the new key on both sides and the parity check will pass.

---

## §6. Record the rotation

Add an entry to the rotation log (paper book in the secure-secrets-room, or whatever your organisation uses for HG-15 four-eyes audit trail):

```
Date:           <YYYY-MM-DD HH:MM TZ>
Operator:       <name>
Second operator: <name>
Old SHA:        <pre-rotation SHA from §1>
New SHA:        <NEW_SHA from §2>
Reason:         <annual / suspected-exfil>
Reference:      ADR-0024 §5; .context/secret-inventory.md
```

DO NOT record the key value itself.

Note the rotation in the on-call channel (the channel post should reference this runbook + the rotation log entry; it should NOT include either SHA).

---

## §7. Suspected exfiltration — off-cadence rotation

If you are rotating because you suspect the current key has been exfiltrated (e.g., a GitHub Actions secret-scan alert, a suspicious access to the production DB, a confirmed accidental key paste into a chat surface):

1. Treat as a PIPEDA s.10.1 breach trigger. Notify the privacy officer BEFORE §3.
2. Complete §3 inside the atomic-swap window.
3. Audit the audit log for the time-window since the suspected exfiltration: `SELECT * FROM audit_log WHERE event_type = 'key_parity.mismatch' AND ts >= <suspected exfil time>` — every mismatch row in this window is a forensic anchor.
4. Notify the second operator + the privacy-reviewer that an emergency rotation occurred.
5. The PIPEDA s.10.1 breach-record floor (24mo) keeps the `key_parity.mismatch` audit rows queryable; do not delete them.

If you cannot prove the new key was generated AFTER the exfiltration window, rotate again. (Two rotations is cheap; an undetected re-use is not.)

---

## §8. Rollback (if §3 went wrong AND the second operator is still on the line)

If §3 produces a mismatch that you cannot resolve in §4 within minutes:

1. Revert the Postgres GUC:
   ```sql
   ALTER SYSTEM SET app.hmac_pseudonym_key = '<OLD_KEY value from 1Password>';
   SELECT pg_reload_conf();
   ```
2. Revert the GH-Actions secret to the old value.
3. Re-run §4. The pre-rotation SHA from §1 should now match.
4. Re-enable CI in §5.
5. The aborted rotation is a non-event for the rotation log — no entry — but **investigate why §3 failed** before attempting again.

If you've already cleared the old key from §3e and no longer have it: the rotation cannot be rolled back. Continue forward and fix the parity check the hard way.

---

## §9. Forensic surface

After a successful rotation:

- The `key_parity.deploy_ok` audit row from the next successful production deploy is the persistent record that the rotation completed.
- The `key_parity.mismatch` audit row from any in-flight deploy that raced the window (if any) is the forensic anchor for "deploy X attempted during the rotation window."
- Both rows are retention class `'24mo'` per ADR-0015 Amendment I.

If a forensic investigation needs to reconstruct the rotation timeline, query:

```sql
SELECT id, ts, event_type, actor_pseudonym, meta
  FROM audit_log
 WHERE event_type IN ('key_parity.mismatch', 'key_parity.deploy_ok')
   AND ts BETWEEN <rotation start> - interval '1h' AND <rotation start> + interval '4h'
 ORDER BY ts;
```

---

## §10. Cross-references

- **ADR-0024 §5** — the policy locked at M0; this runbook is its operational realisation.
- **ADR-0016** — HMAC pseudonymization standard (the GUC + env-var equality invariant).
- **ADR-0015 Amendment I** — retention class `'24mo'` for `key_parity.mismatch` + `key_parity.deploy_ok`.
- **`.context/secret-inventory.md` `$HMAC_PSEUDONYM_KEY` entry** — classification (`deploy-pipeline secret, privacy-adjacent`), emission-surface denylist.
- **`scripts/verify-key-parity-deploy.sh`** — the deploy-time parity check this runbook coordinates with.
- **`scripts/verify-key-entropy.sh`** — the entropy floor enforcement (run against a synthetic fixture in CI; this runbook's §2 generates a real key that satisfies the same floor).
- **threat-model.md §3.14 F-124 / F-125 / F-126** — the testable mitigations this rotation runbook implements.
- **`.context/constraints.md` §Secrets handling** — the project-wide secret hygiene baseline.
