/**
 * T19.1 — PWA manifest + meta-tag scaffolding.
 *
 * Per JHSC-APP-PLAN.md (threat T10): the app MUST be installable as a
 * PWA without requiring an app-store account. That contract has three
 * structural pre-requisites:
 *
 *   1. A `manifest.webmanifest` file in the static-assets directory
 *      with the required PWA fields (name, start_url, display, icons,
 *      colors).
 *   2. `app.html` linking the manifest + advertising the brand
 *      `theme-color` for OS chrome tinting + iOS standalone hints.
 *   3. At least one icon source the OS can rasterize for the home
 *      screen (SVG accepted by iOS 14+ and modern Android; PNG
 *      rasters are a designer follow-up for legacy UA coverage).
 *
 * Before this PR, none of the three were in place — the built
 * `index.html` had no `<link rel="manifest">`, no `<meta name="theme-
 * color">`, and `<link rel="icon" href="data:," />` was a deliberate
 * no-op that prevented `/favicon.ico` 404s but produced an unbranded
 * shell. This file pins the structural contract so a refactor can't
 * silently drop any of the install-prompt requirements.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STATIC_DIR = resolve(__dirname, '../../static');
const MANIFEST_PATH = resolve(STATIC_DIR, 'manifest.webmanifest');
const ICON_PATH = resolve(STATIC_DIR, 'icon.svg');
const APP_HTML_PATH = resolve(__dirname, '../../src/app.html');

describe('T19.1 — PWA manifest scaffolding', () => {
  it('apps/web/static/manifest.webmanifest exists', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it('apps/web/static/icon.svg exists (placeholder mark; designer follow-up replaces with final iconography)', () => {
    expect(existsSync(ICON_PATH)).toBe(true);
  });

  it('the manifest is valid JSON', () => {
    const src = readFileSync(MANIFEST_PATH, 'utf8');
    expect(() => JSON.parse(src)).not.toThrow();
  });
});

describe('T19.1 — manifest required fields (W3C PWA installability)', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  it('declares a `name` (full app name surfaced in install prompt + app-info screens)', () => {
    expect(typeof manifest.name).toBe('string');
    expect(manifest.name.length).toBeGreaterThan(0);
  });

  it('declares a `short_name` (home-screen label, ≤12 chars per UA convention)', () => {
    expect(typeof manifest.short_name).toBe('string');
    expect(manifest.short_name.length).toBeGreaterThan(0);
    // Defense pin against a refactor that picks a long short_name that
    // gets truncated mid-word on Android's home screen.
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it('declares `start_url: "/"` (boot into the landing route on install-launch)', () => {
    expect(manifest.start_url).toBe('/');
  });

  it('declares `scope: "/"` (every route owned by the installed app shell)', () => {
    expect(manifest.scope).toBe('/');
  });

  it('declares `display: "standalone"` (chrome-less app surface on supported UAs)', () => {
    // "standalone" gives the app-like feel without the address bar but
    // keeps the OS status bar. "fullscreen" would hide the status bar
    // too, which is overkill for a form-heavy intake app.
    expect(manifest.display).toBe('standalone');
  });

  it('declares a `theme_color` matching the in-app worker-hub blue accent', () => {
    // Matches the `--color-accent` token painted by app.html's boot
    // stylesheet (#2563eb). Drives the Android URL bar tint + iOS status
    // bar tint when the app is launched in standalone mode; aligning the
    // OS chrome tint with the in-app accent means the chrome flows
    // continuously into the interactive accent the user sees in the
    // shell (sign-in CTA, active step pill, focus states).
    expect(manifest.theme_color).toBe('#2563eb');
  });

  it('declares a `background_color` matching `color.light.background.primary` (used during splash on first launch)', () => {
    expect(manifest.background_color).toBe('#fbfbfa');
  });

  it('declares `lang: "en-CA"` (matches the document lang in app.html)', () => {
    expect(manifest.lang).toBe('en-CA');
  });

  it('declares `id: "/"` (explicit app identity — stable across future start_url changes)', () => {
    // W3C: without an explicit `id`, the manifest's identity is derived
    // from `start_url`. Changing `start_url` later would orphan every
    // already-installed instance — the OS treats the new manifest as a
    // distinct app, and the user has to reinstall to pick up the change.
    // Pinning `id: "/"` decouples identity from `start_url` so a future
    // landing-route refactor doesn't break existing installs.
    expect(manifest.id).toBe('/');
  });

  it('declares `prefer_related_applications: false` (defense against native-app upsell drift)', () => {
    // `false` is the W3C default, but pinning it makes the contract
    // explicit. A future change that flips this to `true` would invite
    // the OS to surface a "Get the native app" banner alongside the
    // install prompt — JHSC's posture (per JHSC-APP-PLAN.md T10) is
    // PWA-installable WITHOUT an app-store account; native-app upsell
    // contradicts that and exposes a forced-disclosure side channel
    // (app-store account records).
    expect(manifest.prefer_related_applications).toBe(false);
  });

  it('declares at least one icon (W3C installability requires icons)', () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('the icons array references /icon.svg (the placeholder SVG mark shipped alongside)', () => {
    const svgIcon = manifest.icons.find(
      (icon: { src: string; type: string }) => icon.src === '/icon.svg'
    );
    expect(svgIcon).toBeDefined();
    expect(svgIcon.type).toBe('image/svg+xml');
  });
});

describe('T19.1 — app.html wires the manifest + brand chrome', () => {
  const src = readFileSync(APP_HTML_PATH, 'utf8');

  it('links the manifest via <link rel="manifest"> with the correct path', () => {
    expect(src).toMatch(
      /<link\s+rel=["']manifest["']\s+href=["']\/manifest\.webmanifest["']\s*\/?>/
    );
  });

  it('declares a light-mode theme-color meta tag matching the in-app accent (#2563eb)', () => {
    // The light variant carries `media="(prefers-color-scheme: light)"`.
    // Order matters: UAs that don't understand media-keyed theme-color
    // pick the FIRST tag, so the light variant must appear before the
    // dark one (verified by string-index in the next test).
    expect(src).toMatch(
      /<meta\s+name=["']theme-color["']\s+content=["']#2563eb["']\s+media=["']\(prefers-color-scheme:\s*light\)["']\s*\/?>/
    );
  });

  it('declares a dark-mode theme-color meta tag matching the dark body background (#0c0e12)', () => {
    // The dark variant uses the body-matched value, not the dark
    // brand-accent (`#a9b3f0` — too light for a status-bar tint). The
    // asymmetry vs the light variant is documented inline in app.html.
    expect(src).toMatch(
      /<meta\s+name=["']theme-color["']\s+content=["']#0c0e12["']\s+media=["']\(prefers-color-scheme:\s*dark\)["']\s*\/?>/
    );
  });

  it('the light-mode theme-color tag appears BEFORE the dark variant (UA back-compat ordering)', () => {
    const lightAt = src.search(/<meta\s+name=["']theme-color["']\s+content=["']#2563eb["']/);
    const darkAt = src.search(/<meta\s+name=["']theme-color["']\s+content=["']#0c0e12["']/);
    expect(lightAt).toBeGreaterThan(-1);
    expect(darkAt).toBeGreaterThan(-1);
    expect(lightAt).toBeLessThan(darkAt);
  });

  it('links the SVG icon (replacing the data:, no-op favicon)', () => {
    expect(src).toMatch(
      /<link\s+rel=["']icon["']\s+href=["']\/icon\.svg["']\s+type=["']image\/svg\+xml["']\s*\/?>/
    );
    // Defense pin: the old data:, no-op favicon link must NOT survive
    // the refactor (it would supersede the real icon in load order if
    // re-added before the icon.svg link).
    expect(src).not.toMatch(/<link\s+rel=["']icon["']\s+href=["']data:["']?,?["']?\s*\/?>/);
  });

  it('links an apple-touch-icon for iOS home-screen install (SVG accepted by iOS 14+)', () => {
    expect(src).toMatch(
      /<link\s+rel=["']apple-touch-icon["']\s+href=["']\/icon\.svg["']\s*\/?>/
    );
  });

  it('advertises iOS standalone mode via apple-mobile-web-app-capable', () => {
    // Without this meta tag, an iOS user who Adds to Home Screen still
    // launches inside Safari with the full address bar. The manifest's
    // display:standalone is ignored by iOS — this meta is the iOS path.
    expect(src).toMatch(
      /<meta\s+name=["']apple-mobile-web-app-capable["']\s+content=["']yes["']\s*\/?>/
    );
  });

  it('declares the iOS status-bar style (default — lets iOS pick tint by surface)', () => {
    // black-translucent would let body content paint under the notch and
    // is a deliberate full-bleed design choice (deferred). Defense pin
    // against a refactor that flips this silently.
    expect(src).toMatch(
      /<meta\s+name=["']apple-mobile-web-app-status-bar-style["']\s+content=["']default["']\s*\/?>/
    );
  });

  it('declares the iOS home-screen title (apple-mobile-web-app-title)', () => {
    // iOS uses this label (not the manifest short_name) for the icon
    // caption on the home screen. Mirror short_name for consistency.
    expect(src).toMatch(
      /<meta\s+name=["']apple-mobile-web-app-title["']\s+content=["']JHSC["']\s*\/?>/
    );
  });
});

describe('T19.1 — icon SVG structural sanity', () => {
  const src = readFileSync(ICON_PATH, 'utf8');

  it('is a well-formed SVG with a viewBox', () => {
    expect(src).toMatch(/<svg\b[^>]*\bviewBox=["']0 0 512 512["']/);
  });

  it('uses the in-app accent color (#2563eb) for the mark background', () => {
    // Defense pin: a refactor that swaps the icon's brand color must
    // also update the manifest theme_color + app.html theme-color meta
    // to stay in sync.
    expect(src).toContain('#2563eb');
  });

  it('carries an aria-label so screen readers announce the icon when surfaced as an <img>', () => {
    // Some UAs render the icon as an <img> in install prompts; the
    // aria-label gives SR users an accessible name without relying on
    // the alt text the UA may not pass through.
    expect(src).toMatch(/aria-label=["']JHSC["']/);
  });
});
