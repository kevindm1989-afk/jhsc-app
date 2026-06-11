/**
 * T19 — register viewers now delegate to the locale-aware
 * date-format helper instead of hand-rolling formatDate /
 * formatTimestamp. /report month nav + YoY tooltip use
 * formatMonthShort.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATE_VIEWERS = [
  'concerns/ConcernsViewer.svelte',
  'recommendations/RecommendationsViewer.svelte',
  'training/TrainingViewer.svelte',
  'work-refusal/WorkRefusalViewer.svelte',
  's51-evidence/S51EvidenceViewer.svelte',
  'reprisal/ReprisalViewer.svelte',
  'minutes/MinutesViewer.svelte',
  'inspections/InspectionsViewer.svelte',
  'library/LibraryViewer.svelte'
] as const;

const TIMESTAMP_VIEWERS = [
  'audit/AuditLogViewer.svelte',
  'audit/SensitiveFeedViewer.svelte'
] as const;

describe('T19 — date-format helper rolled into the 9 date-only viewers', () => {
  for (const v of DATE_VIEWERS) {
    describe(v, () => {
      const src = readFileSync(resolve(__dirname, '../../src/lib', v), 'utf8');

      it('imports formatDateShort from $lib/ui/date-format', () => {
        expect(src).toMatch(
          /import\s*\{[^}]*\bformatDateShort\b[^}]*\}\s+from\s+['"]\$lib\/ui\/date-format['"]/
        );
      });

      it('formatDate delegates to formatDateShort with raw-iso fallback', () => {
        expect(src).toMatch(/formatDateShort\(iso\)\s*\|\|\s*iso/);
      });

      it('no longer hand-rolls a string-strip formatter', () => {
        expect(src).not.toMatch(/iso\.replace\(\/T\.\*\$\//);
      });
    });
  }
});

describe('T19 — date-format helper rolled into the 2 timestamp viewers', () => {
  for (const v of TIMESTAMP_VIEWERS) {
    describe(v, () => {
      const src = readFileSync(resolve(__dirname, '../../src/lib', v), 'utf8');

      it('imports formatDateTime from $lib/ui/date-format', () => {
        expect(src).toMatch(
          /import\s*\{[^}]*\bformatDateTime\b[^}]*\}\s+from\s+['"]\$lib\/ui\/date-format['"]/
        );
      });

      it('formatTimestamp delegates to formatDateTime with raw-iso fallback', () => {
        expect(src).toMatch(/formatDateTime\(iso\)\s*\|\|\s*iso/);
      });

      it('no longer hand-rolls the T-flatten / strip-ms formatter', () => {
        expect(src).not.toMatch(/iso\.replace\(['"]T['"]/);
      });
    });
  }
});

describe('T19 — /report uses formatMonthShort for the nav label + YoY tooltip', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/report/+page.svelte'),
    'utf8'
  );

  it('month-mode label uses formatMonthShort(month)', () => {
    expect(src).toMatch(/isYearView \? year : formatMonthShort\(month\)/);
  });

  it('keeps the raw YYYY-MM in a data-raw attribute for tooling that needs the canonical shape', () => {
    expect(src).toMatch(/data-raw=\{isYearView \? year : month\}/);
  });

  it('YoY tile tooltip formats priorMonth via formatMonthShort', () => {
    expect(src).toMatch(/month:\s*priorMonth\s*\?\s*formatMonthShort\(priorMonth\)/);
  });
});
