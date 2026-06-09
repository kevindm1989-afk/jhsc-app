/**
 * T19.1 — AboutCard (version + key links surface on /settings).
 *
 * Pins:
 *   - Section testid + heading + intro via t().
 *   - Five info rows (app, version, security, threat-model, decisions)
 *     each carry a stable data-testid.
 *   - The security link points to /.well-known/security.txt (RFC 9116
 *     canonical path; the security.txt static file already ships).
 *   - The threat-model + decisions links point to the public GitHub
 *     paths so a curious committee member can read the contracts the
 *     app enforces. rel="noopener external" + target="_blank" on
 *     external links.
 *   - The "Not legal advice" footer copy is present (HG-10 placeholder
 *     until lawyer review).
 *   - Catalog keys are present.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AboutCard from '../../src/lib/ui/AboutCard.svelte';

const SOURCE_PATH = resolve(__dirname, '../../src/lib/ui/AboutCard.svelte');

afterEach(() => {
  cleanup();
});

describe('T19.1 — AboutCard structural pins', () => {
  it('the component file exists at the expected path', () => {
    expect(existsSync(SOURCE_PATH)).toBe(true);
  });

  it('renders the about-section data-testid + heading via t()', () => {
    render(AboutCard);
    expect(screen.getByTestId('about-section')).toBeDefined();
    expect(screen.getByText('About this app')).toBeDefined();
  });

  it('renders the five info rows (app, version, security, threat-model, decisions)', () => {
    render(AboutCard);
    expect(screen.getByTestId('about-app')).toBeDefined();
    expect(screen.getByTestId('about-version')).toBeDefined();
    expect(screen.getByTestId('about-security')).toBeDefined();
    expect(screen.getByTestId('about-threat-model')).toBeDefined();
    expect(screen.getByTestId('about-decisions')).toBeDefined();
  });

  it('the version row renders the value inside a <code>', () => {
    render(AboutCard);
    const v = screen.getByTestId('about-version-value');
    expect(v.tagName.toLowerCase()).toBe('code');
    expect((v.textContent ?? '').length).toBeGreaterThan(0);
  });

  it('the security link points to /.well-known/security.txt (RFC 9116)', () => {
    render(AboutCard);
    const a = screen.getByTestId('about-security-link') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/.well-known/security.txt');
    expect(a.getAttribute('rel') ?? '').toMatch(/noopener/);
  });

  it('the threat-model + decisions links point to the public GitHub paths with rel + target', () => {
    render(AboutCard);
    for (const tid of ['about-threat-model-link', 'about-decisions-link']) {
      const a = screen.getByTestId(tid) as HTMLAnchorElement;
      expect(a.getAttribute('href') ?? '').toMatch(
        /^https:\/\/github\.com\/kevindm1989-afk\/jhsc-app\/blob\/main\/\.context\//
      );
      expect(a.getAttribute('rel') ?? '').toMatch(/noopener/);
      expect(a.getAttribute('target')).toBe('_blank');
    }
  });

  it('renders the "Not legal advice" footer (HG-10 placeholder)', () => {
    render(AboutCard);
    const note = screen.getByTestId('about-license-note');
    expect(note.textContent ?? '').toMatch(/not legal advice/i);
    expect(note.textContent ?? '').toMatch(/privacy lawyer/i);
    expect(note.textContent ?? '').toMatch(/labour-law lawyer/i);
  });

  it('every settings.about.* key referenced is present in the root catalog', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    const about = catalog.settings.about;
    expect(about).toBeDefined();
    expect(typeof about.heading).toBe('string');
    expect(typeof about.intro).toBe('string');
    for (const k of ['app', 'version', 'security', 'threat_model', 'decisions']) {
      expect(typeof about.label[k]).toBe('string');
    }
    expect(typeof about.security_link).toBe('string');
    expect(typeof about.threat_model_link).toBe('string');
    expect(typeof about.decisions_link).toBe('string');
    expect(typeof about.license_note).toBe('string');
  });
});
