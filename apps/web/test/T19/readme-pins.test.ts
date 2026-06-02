/**
 * T19.1 — root README.md + apps/web/README.md content pins.
 *
 * The READMEs are the first surface a contributor / reviewer / future
 * security auditor reads. Two load-bearing claims live in the root
 * README that, if silently dropped, would erode the project's
 * threat-model framing:
 *
 *   - "worker-side" language — the entire ADR set is predicated on
 *     this scope split (employer members are OUT). A README refactor
 *     that says "JHSC app" without the qualifier would invite
 *     contributors to add employer-facing features that the threat
 *     model explicitly forbids.
 *
 *   - "Not legal advice." — the privacy-lawyer + labour-law-lawyer
 *     review obligation is the production-deploy gate. Dropping this
 *     line would let someone interpret the app as launch-ready.
 *
 *   - "Out of scope by design:" block — names the employer roles
 *     explicitly so contributors don't accidentally add features for
 *     them.
 *
 * The apps/web/README.md pins the contributor prerequisites table so
 * a future Node-version bump doesn't drift between the README and
 * `.nvmrc`.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT_README = resolve(__dirname, '../../../../README.md');
const WEB_README = resolve(__dirname, '../../README.md');

describe('T19.1 — root README.md scope + obligation pins', () => {
  it('root README.md exists', () => {
    expect(existsSync(ROOT_README)).toBe(true);
  });

  const src = readFileSync(ROOT_README, 'utf8');

  it('declares the app as **worker-side** in the lead paragraph', () => {
    // Defense pin: the worker-side qualifier is load-bearing for
    // every ADR. A drift to a generic "JHSC app" framing without the
    // qualifier would invite scope-creep features that contradict
    // the threat model.
    expect(src).toMatch(/worker-side/i);
  });

  it('carries the "Out of scope by design" callout naming employer roles', () => {
    expect(src).toMatch(/Out of scope by design/i);
    // The employer co-chair is the canonical OUT-OF-SCOPE role; pin
    // its mention so a refactor doesn't silently soften the exclusion.
    expect(src).toMatch(/employer co-chair/i);
  });

  it('carries the "Not legal advice" + lawyer-review obligation', () => {
    // The privacy-lawyer + labour-law-lawyer review is the
    // production-deploy gate per JHSC-APP-PLAN.md.
    expect(src).toMatch(/Not legal advice/i);
    expect(src).toMatch(/privacy lawyer/i);
    expect(src).toMatch(/labour-law lawyer/i);
  });
});

describe('T19.1 — apps/web/README.md prerequisites table pin', () => {
  it('apps/web/README.md exists', () => {
    expect(existsSync(WEB_README)).toBe(true);
  });

  const src = readFileSync(WEB_README, 'utf8');

  it('documents Node + pnpm + Supabase CLI prerequisites', () => {
    // The prerequisites table is the contributor-onboarding contract.
    // A refactor that drops the table would leave new contributors
    // guessing at the tool stack.
    expect(src).toMatch(/Node\b/);
    expect(src).toMatch(/pnpm/);
    expect(src).toMatch(/Supabase CLI/i);
  });

  it('references `.nvmrc` as the Node-version source of truth (cross-file pin)', () => {
    // The README mentions `.nvmrc` so contributors know where the
    // canonical version lives. CI also reads `.nvmrc` via
    // `node-version-file: '.nvmrc'` (in ci.yml). Pinning the
    // reference here defends the README↔.nvmrc↔CI three-way
    // alignment.
    expect(src).toMatch(/\.nvmrc/);
  });
});
