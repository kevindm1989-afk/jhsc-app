/**
 * Test helper — extract text from a minimal PDF emitted by `export-renderer`.
 *
 * The library's hand-rolled PDF emitter writes a single content stream
 * containing one `Tj` operator per logical line. Each Tj operand is a
 * parenthesised PDF string literal with PDF-escape sequences for
 * backslash + parentheses (no hex strings, no font subsets, no streams
 * compressed via /FlateDecode).
 *
 * This helper scans the raw bytes for every `(...)Tj` literal and
 * decodes the escapes. The output is the concatenation of every literal,
 * joined by newlines so the test's `.toContain(SOURCE_NAME)` assertion
 * trivially fails when source-name plaintext appears (the F-19 PDF
 * text-grep test).
 *
 * The helper is intentionally NOT a general-purpose PDF parser. If the
 * production renderer at T11.1 switches to a real PDF library, this
 * helper is replaced with the matching reader (or, ideally, the helper
 * disappears and the test reads the JSON sidecar).
 */

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // Decode bytes as Latin-1 (the renderer wrote one byte per char).
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    text += String.fromCharCode(bytes[i]!);
  }
  const lines: string[] = [];
  // Match `(literal) Tj` (with optional whitespace). The literal cannot
  // contain unescaped parens — the emitter writes `\(` / `\)`.
  const re = /\(((?:\\\\|\\\(|\\\)|[^()])*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? '';
    // Reverse pdfEscape: backslash + parens.
    const decoded = raw
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    lines.push(decoded);
  }
  return lines.join('\n');
}
