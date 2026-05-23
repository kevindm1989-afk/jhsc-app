/**
 * Synthetic JPEG fixtures with known EXIF / IPTC / XMP segments.
 *
 * The fixtures are minimal: a JPEG envelope (SOI ... EOI) carrying a
 * single APP segment containing the targeted metadata payload. They are
 * NOT a fully decodable image; they exist to round-trip a known-shape
 * byte sequence through the sanitize pipeline and assert removal.
 *
 * Source obligations:
 *   - test-plan.md §3.F — synthetic photo fixtures with known
 *     EXIF/IPTC/XMP tags.
 *   - apps/web/test/T10/photo-sanitize.test.ts — consumer.
 */

const MARK = 0xff;
const M_SOI = 0xd8;
const M_EOI = 0xd9;
const M_APP0 = 0xe0; // JFIF
const M_APP1 = 0xe1; // EXIF + XMP
const M_APP13 = 0xed; // IPTC (Photoshop)
const M_COM = 0xfe; // JFIF comment

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function be16(n: number): [number, number] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

/** Build a JPEG segment with `marker` and `payload`. */
function segment(marker: number, payload: Uint8Array): Uint8Array {
  // Segment length = 2 (length bytes) + payload.length.
  const len = 2 + payload.length;
  const out = new Uint8Array(2 + 2 + payload.length);
  out[0] = MARK;
  out[1] = marker;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(payload, 4);
  return out;
}

function ascii(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// EXIF — TIFF/IFD layout with a GPS IFD
// ---------------------------------------------------------------------------

/**
 * Build a minimal TIFF/IFD payload carrying a GPS IFD with the supplied
 * latitude / longitude. The format follows the standard EXIF layout
 * sufficient to be detected by `parseExif` and to carry the
 * decimal-degree-shaped text that the byte-grep test checks.
 *
 * The exact byte layout is implementation-detail; the assertion the
 * pipeline makes is "no APP1 with `Exif\0\0` survives", which any
 * conforming sanitizer satisfies.
 */
function buildExifPayload(lat: number, lon: number): Uint8Array {
  // EXIF identifier ("Exif\0\0") + TIFF header + a minimal IFD pointing
  // to a GPS IFD whose ASCII strings encode the lat/lon as decimal-
  // degree text.
  const exifHeader = ascii('Exif\0\0');
  // TIFF header: II (little-endian) + 0x002A magic + offset to IFD0 (=8).
  const tiffHeader = new Uint8Array([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00
  ]);
  // Encode lat/lon as ASCII; the byte-grep relies on these decimal-
  // degree shapes appearing in the EXIF bytes pre-strip.
  const latStr = `${lat}`;
  const lonStr = `${lon}`;
  // Embed the strings near the start so the byte-grep finds them.
  const gpsBlock = ascii(`GPS:${latStr},${lonStr}\0`);
  return concat(exifHeader, tiffHeader, gpsBlock);
}

export async function buildJpegWithExifGps(opts: {
  lat: number;
  lon: number;
  jfif_comment?: string;
}): Promise<Uint8Array> {
  const soi = new Uint8Array([MARK, M_SOI]);
  const eoi = new Uint8Array([MARK, M_EOI]);
  const exifSeg = segment(M_APP1, buildExifPayload(opts.lat, opts.lon));
  const parts: Uint8Array[] = [soi, exifSeg];
  if (opts.jfif_comment) {
    parts.push(segment(M_COM, ascii(opts.jfif_comment)));
  }
  parts.push(eoi);
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// IPTC — APP13 / Photoshop / 8BIM marker
// ---------------------------------------------------------------------------

function buildIptcPayload(byline: string): Uint8Array {
  // Photoshop 3.0 IPTC envelope, simplified — the assertion the test
  // makes is that the byline string is gone from the post-sanitize
  // bytes. The wrapper is enough to identify the segment as IPTC.
  const header = ascii('Photoshop 3.0\0');
  const eightBim = ascii('8BIM\x04\x04\0\0');
  const bylineRecord = concat(
    new Uint8Array([0x1c, 0x02, 0x50]), // IPTC tag 2:80 (By-line)
    be16(byline.length) as unknown as Uint8Array,
    ascii(byline)
  );
  // The be16 helper returns a tuple — wrap in Uint8Array.
  const lenBytes = new Uint8Array(be16(byline.length));
  const record = concat(
    new Uint8Array([0x1c, 0x02, 0x50]),
    lenBytes,
    ascii(byline)
  );
  void bylineRecord;
  return concat(header, eightBim, record);
}

export async function buildJpegWithIptc(opts: { byline: string }): Promise<Uint8Array> {
  const soi = new Uint8Array([MARK, M_SOI]);
  const eoi = new Uint8Array([MARK, M_EOI]);
  const iptcSeg = segment(M_APP13, buildIptcPayload(opts.byline));
  return concat(soi, iptcSeg, eoi);
}

// ---------------------------------------------------------------------------
// XMP — APP1 with `http://ns.adobe.com/xap/1.0/\0` identifier
// ---------------------------------------------------------------------------

function buildXmpPayload(creator_tool: string): Uint8Array {
  const id = ascii('http://ns.adobe.com/xap/1.0/\0');
  const packet = ascii(
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" ` +
      `xmp:CreatorTool="${creator_tool}"/>` +
      `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
  return concat(id, packet);
}

export async function buildJpegWithXmp(opts: { creator_tool: string }): Promise<Uint8Array> {
  const soi = new Uint8Array([MARK, M_SOI]);
  const eoi = new Uint8Array([MARK, M_EOI]);
  const xmpSeg = segment(M_APP1, buildXmpPayload(opts.creator_tool));
  return concat(soi, xmpSeg, eoi);
}

// ---------------------------------------------------------------------------
// JFIF — APP0 (used as a baseline for "no-metadata" assertions)
// ---------------------------------------------------------------------------

export async function buildBaselineJpeg(): Promise<Uint8Array> {
  const soi = new Uint8Array([MARK, M_SOI]);
  const eoi = new Uint8Array([MARK, M_EOI]);
  const jfif = segment(M_APP0, concat(ascii('JFIF\0'), new Uint8Array([0x01, 0x01])));
  return concat(soi, jfif, eoi);
}
