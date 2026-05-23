/**
 * Export renderer (T11/T12).
 *
 * Pure function — takes a closed-allowlist field set + a typed row, returns
 * PDF/JSON bytes. NO concern-derived plaintext can leak unless the field
 * name is explicitly in the allowlist.
 *
 * The PDF emitter is intentionally minimal — it produces a well-formed PDF
 * "shell" plus the allowlist plaintext as a stream of text. The production
 * wire-up at T11.1/T12.1 may swap in a typeset PDF library (with the
 * caveat the hard rules already specify: no analytics/telemetry).
 *
 * Why dependency-free: T11/T12 are library-only per ADR-0002 Amendment H;
 * the test asserts the PDF bytes contain the allowed plaintext AND the
 * test asserts source-name plaintext NEVER appears. A minimal valid-shape
 * PDF emitter is the smallest surface that satisfies both — the body of
 * the PDF is a literal text stream of the allowlist projection, so
 * `extractPdfText` (in the test helper) reads it back deterministically.
 *
 * Source: F-19 (allowlist) + F-27 (hash binding) + F-25 (browser-only —
 * caller assembles bytes; no server route returns application/pdf).
 */

import type { MinutesFinalRow, RecommendationRow } from './export-store';
import {
  CONCERN_DERIVED_FIELD_ANNOTATIONS,
  EXPORT_ALLOWLIST_MINUTES,
  EXPORT_ALLOWLIST_RECOMMENDATION,
  type ExportAllowlistMinutesKey,
  type ExportAllowlistRecommendationKey
} from './allowlist';
import type { ExportKind } from './types';

/**
 * Project a minutes row through the closed allowlist.
 *
 * The function is intentionally written as a literal switch (NOT a spread)
 * over each allowlist key. ESLint's `no-restricted-syntax` rule from the
 * F-19 contract forbids `...row` here; only `EXPORT_ALLOWLIST_MINUTES`
 * may be spread, and only when constructing the field list (read).
 */
export function projectMinutesByAllowlist(
  row: MinutesFinalRow,
  allowlist: readonly ExportAllowlistMinutesKey[] = EXPORT_ALLOWLIST_MINUTES
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowlist) {
    switch (k) {
      case 'minutes_id':
        out.minutes_id = row.id;
        break;
      case 'finalized_at':
        out.finalized_at = new Date(row.finalized_at).toISOString();
        break;
      case 'agenda_items':
        out.agenda_items = [...row.agenda_items];
        break;
      case 'decisions':
        out.decisions = [...row.decisions];
        break;
      case 'recommendations_summary':
        out.recommendations_summary = row.recommendations_summary;
        break;
      case 'attendees_present':
        out.attendees_present = [...row.attendees_present];
        break;
      case 'next_meeting_at':
        out.next_meeting_at =
          row.next_meeting_at !== null ? new Date(row.next_meeting_at).toISOString() : null;
        break;
      case 'co_chair_signature_block':
        out.co_chair_signature_block = row.co_chair_signature_block;
        break;
      default: {
        // Compile-time exhaustiveness. If an allowlist entry is added
        // without a renderer case, TypeScript fails on the line below.
        const _exhaustive: never = k;
        void _exhaustive;
      }
    }
  }
  return out;
}

export function projectRecommendationByAllowlist(
  row: RecommendationRow,
  allowlist: readonly ExportAllowlistRecommendationKey[] = EXPORT_ALLOWLIST_RECOMMENDATION
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowlist) {
    switch (k) {
      case 'recommendation_id':
        out.recommendation_id = row.id;
        break;
      case 'title':
        out.title = row.title;
        break;
      case 'body':
        out.body = row.body;
        break;
      case 'rationale':
        out.rationale = row.rationale;
        break;
      case 'created_at':
        out.created_at = new Date(row.created_at).toISOString();
        break;
      case 'sent_at':
        out.sent_at = row.sent_at !== null ? new Date(row.sent_at).toISOString() : null;
        break;
      case 'twentyone_day_due_at':
        out.twentyone_day_due_at =
          row.twentyone_day_due_at !== null
            ? new Date(row.twentyone_day_due_at).toISOString()
            : null;
        break;
      case 'co_chair_signature_block':
        out.co_chair_signature_block = row.co_chair_signature_block;
        break;
      default: {
        const _exhaustive: never = k;
        void _exhaustive;
      }
    }
  }
  return out;
}

/**
 * Render the allowlist projection to a JSON byte stream. Used in tests +
 * as the canonical secondary format the audit row may reference.
 */
export function renderJson(projection: Record<string, unknown>): Uint8Array {
  const json = JSON.stringify(projection, null, 2);
  return new TextEncoder().encode(json);
}

// ---------------------------------------------------------------------------
// Minimal PDF emitter (hand-rolled; zero dependencies)
// ---------------------------------------------------------------------------

/**
 * Encode a UTF-8 string as a PDF literal string with parentheses escaped.
 */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Flatten a projection into an array of human-readable lines. The order
 * matches the allowlist key order so the rendered output is deterministic.
 */
function projectionToLines(kind: ExportKind, projection: Record<string, unknown>): string[] {
  const headline =
    kind === 'minutes.final'
      ? 'JHSC — Finalized minutes (s.9(21))'
      : 'JHSC — Recommendation (s.9(20))';
  const lines: string[] = [headline, ''];
  for (const [k, v] of Object.entries(projection)) {
    const label = humanizeLabel(k);
    if (Array.isArray(v)) {
      lines.push(`${label}:`);
      for (const item of v) lines.push(`  - ${String(item)}`);
    } else if (v === null || v === undefined) {
      lines.push(`${label}: (none)`);
    } else {
      lines.push(`${label}: ${String(v)}`);
    }
  }
  return lines;
}

function humanizeLabel(key: string): string {
  // Light snake_case → Title Case. Pure formatting — the LABEL must never
  // surface PI; the values come straight from the allowlist projection.
  return key
    .split('_')
    .map((part) => (part.length === 0 ? '' : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * Emit a single-page PDF whose content stream contains every line of the
 * projection. The bytes are well-formed enough that the test helper's
 * `extractPdfText` (which scans for parenthesised literals in the content
 * stream) returns the concatenation of all visible text.
 *
 * The page size is US Letter (612 × 792 pt) and the font is the built-in
 * Helvetica resource so no font subsetting / embedding is needed. The
 * line stride is hard-coded to 14 pt; long text is NOT wrapped (the
 * audience reads the JSON sibling for full structure).
 */
export function renderPdf(kind: ExportKind, projection: Record<string, unknown>): Uint8Array {
  const lines = projectionToLines(kind, projection);

  // Build the page-content stream. Each line uses a Tj operator at a
  // descending y coordinate. The first text operator opens BT/ET.
  const contentLines: string[] = [];
  contentLines.push('BT');
  contentLines.push('/F1 12 Tf');
  contentLines.push('1 0 0 1 72 740 Tm');
  let yOffset = 0;
  for (const line of lines) {
    if (yOffset > 0) {
      contentLines.push('0 -14 Td');
    }
    contentLines.push(`(${pdfEscape(line)}) Tj`);
    yOffset += 1;
  }
  contentLines.push('ET');
  const contentStream = contentLines.join('\n');

  // Build the cross-reference / object table. PDF requires objects to be
  // serialized with byte-precise offsets recorded in the xref table.
  const header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';

  type Obj = { id: number; body: string };
  const objects: Obj[] = [];
  objects.push({
    id: 1,
    body: '<< /Type /Catalog /Pages 2 0 R >>'
  });
  objects.push({
    id: 2,
    body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  });
  objects.push({
    id: 3,
    body:
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  });
  objects.push({
    id: 4,
    body: `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`
  });
  objects.push({
    id: 5,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  });

  const offsets: number[] = [];
  let body = header;
  for (const obj of objects) {
    offsets.push(body.length);
    body += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  // PDF spec permits Latin-1; jsdom's TextEncoder is UTF-8. The content
  // stream is ASCII; the binary marker comment is the only non-ASCII
  // segment. Encode as Latin-1 via a manual byte-array to avoid
  // double-byte encoding of the marker.
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) {
    out[i] = body.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Render the export to PDF bytes for a minutes row, given an allowlist.
 *
 * The `allowlist` parameter is the load-bearing F-27 binding: the same
 * constant the audit row's `field_set_hash` is computed against MUST be
 * the constant passed here. The caller (`proceedExport`) supplies the
 * canonical allowlist; the test injects a different one via the
 * `__test_overrideRendererAllowlist` hook to verify the integrity check.
 */
export function renderMinutesPdf(
  row: MinutesFinalRow,
  allowlist: readonly ExportAllowlistMinutesKey[] = EXPORT_ALLOWLIST_MINUTES
): Uint8Array {
  const projection = projectMinutesByAllowlist(row, allowlist);
  return renderPdf('minutes.final', projection);
}

export function renderRecommendationPdf(
  row: RecommendationRow,
  allowlist: readonly ExportAllowlistRecommendationKey[] = EXPORT_ALLOWLIST_RECOMMENDATION
): Uint8Array {
  const projection = projectRecommendationByAllowlist(row, allowlist);
  return renderPdf('recommendation', projection);
}

/**
 * Concern-derived annotation lookup for the interstitial flag.
 *
 * Returns the subset of allowlist field names that may carry concern-
 * derived content, given the export kind.
 */
export function concernDerivedAnnotatedFields(kind: ExportKind): readonly string[] {
  return CONCERN_DERIVED_FIELD_ANNOTATIONS[kind];
}
