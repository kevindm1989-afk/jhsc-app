/**
 * Pure helper for rendering a string with a query substring marked.
 *
 * Returns a list of `{ text, match }` segments so the consumer can
 * wrap matching segments in `<mark>` (or any other element) without
 * the helper needing to know about the DOM.
 *
 * Behaviour:
 *   - Case-insensitive substring match.
 *   - All occurrences of the query within `text` produce match
 *     segments; the rest stay plain.
 *   - Empty query (or whitespace-only) → a single non-matching
 *     segment containing the original text.
 *   - Empty text → empty list.
 */

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function highlightMatches(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const q = query.trim();
  if (!q) return [{ text, match: false }];

  const segments: HighlightSegment[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = q.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (idx > cursor) {
      segments.push({ text: text.slice(cursor, idx), match: false });
    }
    segments.push({ text: text.slice(idx, idx + q.length), match: true });
    cursor = idx + q.length;
  }
  return segments;
}
