/**
 * T19.1 — `/.well-known/security.txt` (RFC 9116) pin.
 *
 * RFC 9116 defines the conventional discovery file for vulnerability
 * disclosure. A researcher fetching the path expects:
 *
 *   - `Contact:` — REQUIRED. A method for reporting vulnerabilities.
 *     We point to GitHub's private security-advisory form (the right
 *     surface for a GitHub-hosted repo; avoids exposing a personal
 *     email).
 *   - `Expires:` — REQUIRED. ISO-8601 datetime in the future. We use
 *     2027-06-02T00:00:00Z (1 year out at file creation). A calendar
 *     reminder is needed to refresh before that date; once expired,
 *     researchers may not trust the file.
 *   - `Preferred-Languages:` — RECOMMENDED. en-CA + en.
 *
 * SvelteKit adapter-static copies `apps/web/static/.well-known/` to
 * `build/.well-known/`, so the deployed origin serves the file at
 * the canonical path.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PATH = resolve(__dirname, '../../static/.well-known/security.txt');

describe('T19.1 — /.well-known/security.txt (RFC 9116)', () => {
  it('file exists at apps/web/static/.well-known/security.txt', () => {
    expect(existsSync(PATH)).toBe(true);
  });

  const src = readFileSync(PATH, 'utf8');

  it('declares a Contact: field (RFC 9116 REQUIRED)', () => {
    expect(src).toMatch(/^Contact:\s*\S+/m);
  });

  it('the Contact value points to the GitHub security-advisory form (not a personal email)', () => {
    // Defense pin: drift to a personal email would publish that
    // address. The GitHub URL routes through GitHub's private
    // vulnerability disclosure flow.
    expect(src).toMatch(
      /^Contact:\s*https:\/\/github\.com\/[\w-]+\/[\w-]+\/security\/advisories\/new\s*$/m
    );
  });

  it('declares an Expires: field with an ISO-8601 future datetime (RFC 9116 REQUIRED)', () => {
    const match = src.match(/^Expires:\s*(\S+)/m);
    expect(match).not.toBeNull();
    const expiresAt = match?.[1] ?? '';
    expect(expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Must be in the future. Tests run under a frozen clock
    // (FROZEN_NOW_ISO = 2026-05-22), so as long as the date is
    // after that the contract holds; a year-out value is the
    // standard convention.
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  });

  it('declares Preferred-Languages: with en-CA (RFC 9116 RECOMMENDED; matches the app locale)', () => {
    expect(src).toMatch(/^Preferred-Languages:\s*.*en-CA/m);
  });

  it('does NOT include unverifiable Canonical: or Policy: URLs (defense pin)', () => {
    // A Canonical: pointing to a placeholder URL would mislead
    // researchers; a Policy: pointing to a non-existent SECURITY.md
    // would 404. Both are RECOMMENDED but not REQUIRED — better to
    // omit until they can be wired authentically.
    expect(src).not.toMatch(/^Canonical:/m);
    expect(src).not.toMatch(/^Policy:/m);
  });
});
