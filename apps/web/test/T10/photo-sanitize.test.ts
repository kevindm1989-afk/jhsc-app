/**
 * T10 — Photo capture: EXIF / IPTC / XMP / GPS strip (HG-5 / ADR-0011 amendment).
 *
 * Source obligations:
 *   - ADR-0011 amendment (HG-5) — strip ALL metadata client-side BEFORE
 *     encryption; re-encode through HTMLCanvasElement; round-trip
 *     verification; defensive byte-grep.
 *   - threat-model §8 T10 — F-46 (EXIF strip).
 *   - design-system §4.E (Surface E — photo capture).
 *   - i18n en-CA — `photo.preview.gps_advisory`, `photo.location.label`.
 *
 * The pipeline lives in `src/lib/photo/sanitize.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sanitizePhoto } from '../../src/lib/photo/sanitize';
import {
  FIXTURE_EXIF_GPS_LAT,
  FIXTURE_EXIF_GPS_LON,
  FIXTURE_EXIF_IPTC_BYLINE,
  FIXTURE_EXIF_XMP_CREATOR_TOOL,
  ONTARIO_DECIMAL_DEGREES_RE,
} from '../_helpers/fixtures';
import { buildJpegWithExifGps, buildJpegWithIptc, buildJpegWithXmp } from '../_helpers/exif-fixtures';
import { parseExif, parseIptc, parseXmp } from '../_helpers/exif-parser';
import { freezeClock, restoreClock } from '../_helpers/clock';

beforeEach(() => freezeClock());
afterEach(() => restoreClock());

describe('T10 / HG-5 / ADR-0011 amendment / F-46 — photo metadata strip + canvas re-encode', () => {
  // ---- Round-trip GPS strip --------------------------------------------

  it('T10 / HG-5 round-trip — input JPEG with known EXIF GPS at workplace coords → post-sanitize bytes contain ZERO EXIF and ZERO GPS coords', async () => {
    const inputBytes = await buildJpegWithExifGps({
      lat: FIXTURE_EXIF_GPS_LAT,
      lon: FIXTURE_EXIF_GPS_LON,
    });
    const out = await sanitizePhoto(inputBytes);
    const exif = await parseExif(out.bytes);
    expect(exif.tags).toEqual({});
    // Defensive byte-grep for decimal-degrees within Ontario bbox.
    const asLatin1 = Buffer.from(out.bytes).toString('latin1');
    expect(asLatin1).not.toMatch(ONTARIO_DECIMAL_DEGREES_RE);
  });

  // ---- IPTC by-line --------------------------------------------------

  it('T10 / HG-5 — input JPEG with IPTC by-line tag → post-sanitize bytes contain no IPTC tags', async () => {
    const inputBytes = await buildJpegWithIptc({ byline: FIXTURE_EXIF_IPTC_BYLINE });
    const out = await sanitizePhoto(inputBytes);
    const iptc = await parseIptc(out.bytes);
    expect(iptc.tags).toEqual({});
    expect(Buffer.from(out.bytes).toString('latin1')).not.toContain(FIXTURE_EXIF_IPTC_BYLINE);
  });

  // ---- XMP creator-tool ----------------------------------------------

  it('T10 / HG-5 — input JPEG with XMP `xmp:CreatorTool` tag → post-sanitize bytes contain no XMP packet', async () => {
    const inputBytes = await buildJpegWithXmp({ creator_tool: FIXTURE_EXIF_XMP_CREATOR_TOOL });
    const out = await sanitizePhoto(inputBytes);
    const xmp = await parseXmp(out.bytes);
    expect(xmp.tags).toEqual({});
    expect(Buffer.from(out.bytes).toString('latin1')).not.toContain(FIXTURE_EXIF_XMP_CREATOR_TOOL);
  });

  // ---- Sanitize runs BEFORE encrypt ----------------------------------

  it('T10 / HG-5 amendment rule 1 — sanitizePhoto runs BEFORE libsodium crypto_secretbox; no path uploads raw camera bytes', async () => {
    const inputBytes = await buildJpegWithExifGps({
      lat: FIXTURE_EXIF_GPS_LAT,
      lon: FIXTURE_EXIF_GPS_LON,
    });
    const pipeline = await sanitizePhoto.__pipelineForTest(inputBytes);
    expect(pipeline.steps).toEqual(['strip_metadata', 'canvas_reencode', 'secretbox_encrypt']);
  });

  // ---- Canvas re-encode is observable as a destructive transform -----

  it('T10 / HG-5 — canvas re-encode produces output whose byte-set has zero overlap with the input EXIF segment bytes', async () => {
    const inputBytes = await buildJpegWithExifGps({
      lat: FIXTURE_EXIF_GPS_LAT,
      lon: FIXTURE_EXIF_GPS_LON,
    });
    const out = await sanitizePhoto(inputBytes);
    // EXIF segment marker is 0xFFE1; after canvas re-encode the segment must
    // be absent or empty.
    const outBuf = Buffer.from(out.bytes);
    let i = 0;
    while ((i = outBuf.indexOf(Buffer.from([0xff, 0xe1]), i)) !== -1) {
      // If any APP1 segment exists, its payload MUST NOT contain "Exif\0\0".
      const lenHi = outBuf[i + 2];
      const lenLo = outBuf[i + 3];
      const segLen = (lenHi << 8) | lenLo;
      const segPayload = outBuf.slice(i + 4, i + 2 + segLen);
      expect(segPayload.toString('latin1')).not.toContain('Exif\0\0');
      i += 1;
    }
  });

  // ---- Defensive byte-grep ------------------------------------------

  it('T10 / HG-5 (defensive byte-grep) — even a non-EXIF embedded comment containing decimal-degree shapes is caught', async () => {
    const inputBytes = await buildJpegWithExifGps({
      lat: FIXTURE_EXIF_GPS_LAT,
      lon: FIXTURE_EXIF_GPS_LON,
      // Inject a fake JFIF comment segment carrying coords as text.
      jfif_comment: `Captured at ${FIXTURE_EXIF_GPS_LAT},${FIXTURE_EXIF_GPS_LON}`,
    });
    const out = await sanitizePhoto(inputBytes);
    const asLatin1 = Buffer.from(out.bytes).toString('latin1');
    expect(asLatin1).not.toMatch(ONTARIO_DECIMAL_DEGREES_RE);
  });

  // ---- Determinism -------------------------------------------------

  it('T10 / HG-5 — sanitize is deterministic: same input bytes → same output bytes', async () => {
    const inputBytes = await buildJpegWithExifGps({
      lat: FIXTURE_EXIF_GPS_LAT,
      lon: FIXTURE_EXIF_GPS_LON,
    });
    const a = await sanitizePhoto(inputBytes);
    const b = await sanitizePhoto(inputBytes);
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
  });

  // ---- "Use my current location" surface is structurally absent ---

  it('T10 / a11y-review §5.6 / HG-5 — no UI surface offers a "use my current location" affordance', async () => {
    const { default: PhotoCaptureSurface } = await import(
      '../../src/lib/photo/PhotoCaptureSurface.svelte'
    );
    const { render, screen } = await import('@testing-library/svelte');
    render(PhotoCaptureSurface);
    // Search for the forbidden affordances.
    expect(screen.queryByText(/use my (current )?location/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /use.*location/i })).toBeNull();
  });
});
