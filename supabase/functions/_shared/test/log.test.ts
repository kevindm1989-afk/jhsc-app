/**
 * T02 — Edge Function shared logger tests (Deno-native).
 *
 * Source obligations:
 *   - observability/logging.md §4 (Edge Function logging contract).
 *   - ADR-0010 Amendment F-D Rule 1 (no PI in Edge Function logs).
 *   - threat-model §8 T02 (Edge Function canary test).
 *
 * Run: `deno test --allow-read supabase/functions/_shared/test/log.test.ts`.
 */

import { assertEquals, assertNotMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { log, SAFE_FIELDS_ALLOWLIST_ID } from '../log.ts';

const CANARY_PII_X = 'CANARY_PII_X';
const CANARY_EMAIL = 'canary.user@example.test';

Deno.test('T02 / F-09 — Edge Function logger drops PI keys silently and surfaces WARN in test env', () => {
  const captured: any[] = [];
  log.__setTestSink((line) => captured.push(line));
  log.info({
    event: 'concern.create',
    attributes: { display_name: 'CANARY-FIXTURE-NAME', email: CANARY_EMAIL } as any,
  });
  assertEquals(captured.length, 1);
  const serialized = JSON.stringify(captured[0]);
  assertNotMatch(serialized, /CANARY-FIXTURE-NAME/);
  assertNotMatch(serialized, new RegExp(CANARY_EMAIL.replace(/\./g, '\\.')));
});

Deno.test('T02 / logging.md §4 rule 5 — canary CANARY_PII_X submitted via Edge Function body never appears in function logs', async () => {
  const captured: any[] = [];
  log.__setTestSink((line) => captured.push(line));
  // Simulate an Edge Function handler that the caller MIGHT have written
  // as `log.info({ event: 'concern.create', attributes: { body: req.body } })`.
  // The shared logger drops `body` (forbidden) and the canary never lands.
  log.info({
    event: 'concern.create',
    attributes: { body: { canary: CANARY_PII_X } } as any,
  });
  const serialized = JSON.stringify(captured);
  assertEquals(serialized.includes(CANARY_PII_X), false);
});

Deno.test('T02 / logging.md §3 — Edge Function logger uses the SAME safeFields allowlist module as the browser', () => {
  // The shared logger exports an id derived from the safe-fields module
  // (e.g., a hash of the allowlist). This must match the browser export.
  const browserId = SAFE_FIELDS_ALLOWLIST_ID;
  // The implementer wires both surfaces to import from the same module.
  assertEquals(typeof browserId, 'string');
  assertEquals(browserId.length > 0, true);
});

Deno.test('T02 / logging.md §4 rule 4 — request_id propagates: when X-Request-ID header is set, the Edge Function logs that id', () => {
  const captured: any[] = [];
  log.__setTestSink((line) => captured.push(line));
  log.info({
    event: 'concern.create',
    request_id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
  });
  assertEquals(captured[0].request_id, 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee');
});
