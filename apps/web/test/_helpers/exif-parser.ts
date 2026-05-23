/**
 * Minimal EXIF / IPTC / XMP parser.
 *
 * Detects whether the JPEG byte stream contains the segment-identifier
 * shapes for EXIF (`Exif\0\0`), IPTC (`Photoshop 3.0\0` + 8BIM), and XMP
 * (`http://ns.adobe.com/xap/1.0/\0`). The parser returns a `tags` map;
 * if the segment is absent, `tags` is empty.
 *
 * The test harness uses this for the round-trip assertion:
 *   - pre-strip: tags is non-empty.
 *   - post-strip: tags is empty.
 *
 * Source obligations:
 *   - test-plan.md §3.F — EXIF/IPTC/XMP parser shim.
 *   - apps/web/test/T10/photo-sanitize.test.ts — consumer.
 */

const MARK = 0xff;
const M_APP_MIN = 0xe0;
const M_APP_MAX = 0xef;

interface ParsedSegment {
  tags: Record<string, unknown>;
}

/** Walk JPEG markers and collect every APPn segment payload. */
function collectAppSegments(input: Uint8Array): Array<{ marker: number; payload: Uint8Array }> {
  const out: Array<{ marker: number; payload: Uint8Array }> = [];
  if (input.length < 2 || input[0] !== MARK || input[1] !== 0xd8) return out;
  let i = 2;
  while (i < input.length) {
    if (input[i] !== MARK) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < input.length && input[j] === MARK) j += 1;
    if (j >= input.length) break;
    const m = input[j]!;
    if (m === 0xd9) break; // EOI
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x00) {
      i = j + 1;
      continue;
    }
    if (j + 2 >= input.length) break;
    const segLen = (input[j + 1]! << 8) | input[j + 2]!;
    const payloadStart = j + 3;
    const payloadEnd = j + 1 + segLen;
    if (payloadEnd > input.length) break;
    if (m >= M_APP_MIN && m <= M_APP_MAX) {
      out.push({
        marker: m,
        payload: input.slice(payloadStart, payloadEnd)
      });
    }
    i = payloadEnd;
  }
  return out;
}

function payloadStartsWith(payload: Uint8Array, prefix: string): boolean {
  const enc = Buffer.from(prefix, 'latin1');
  if (payload.length < enc.length) return false;
  for (let i = 0; i < enc.length; i++) {
    if (payload[i] !== enc[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// parseExif — detects `Exif\0\0` in APP1
// ---------------------------------------------------------------------------

export async function parseExif(bytes: Uint8Array): Promise<ParsedSegment> {
  const segs = collectAppSegments(bytes);
  for (const s of segs) {
    if (s.marker === 0xe1 && payloadStartsWith(s.payload, 'Exif\0\0')) {
      return { tags: { exif: true, payload_length: s.payload.length } };
    }
  }
  return { tags: {} };
}

// ---------------------------------------------------------------------------
// parseIptc — detects `Photoshop 3.0\0` in APP13
// ---------------------------------------------------------------------------

export async function parseIptc(bytes: Uint8Array): Promise<ParsedSegment> {
  const segs = collectAppSegments(bytes);
  for (const s of segs) {
    if (s.marker === 0xed && payloadStartsWith(s.payload, 'Photoshop 3.0\0')) {
      return { tags: { iptc: true, payload_length: s.payload.length } };
    }
  }
  return { tags: {} };
}

// ---------------------------------------------------------------------------
// parseXmp — detects `http://ns.adobe.com/xap/1.0/\0` in APP1
// ---------------------------------------------------------------------------

export async function parseXmp(bytes: Uint8Array): Promise<ParsedSegment> {
  const segs = collectAppSegments(bytes);
  for (const s of segs) {
    if (s.marker === 0xe1 && payloadStartsWith(s.payload, 'http://ns.adobe.com/xap/1.0/\0')) {
      return { tags: { xmp: true, payload_length: s.payload.length } };
    }
  }
  return { tags: {} };
}
