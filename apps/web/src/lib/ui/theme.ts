/**
 * Theme store — three-way light / dark / system preference, persisted to
 * localStorage under `jhsc:theme` and applied to `<html data-theme>`.
 *
 * Mirrors the worker-hub theme model (light → dark → system cycle). The
 * pre-paint apply happens in `static/theme-init.js` (CSP-safe, no FOUC);
 * this store keeps the in-app UI reactive and re-applies on user toggle.
 *
 * No raw color values live here — the palette is defined as CSS custom
 * properties in `app.html` and switched by the `data-theme` attribute /
 * `prefers-color-scheme` media query. This module only flips the attribute.
 */
import { writable } from 'svelte/store';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'jhsc:theme';
const ORDER: readonly Theme[] = ['light', 'dark', 'system'];

function read(): Theme {
  if (typeof localStorage === 'undefined') return 'system';
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Apply a preference to the DOM. 'system' clears the attribute so the
 *  prefers-color-scheme media query governs (the default, no-override path). */
function apply(next: Theme): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (next === 'light' || next === 'dark') el.setAttribute('data-theme', next);
  else el.removeAttribute('data-theme');
}

export const theme = writable<Theme>(read());

export function setTheme(next: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* localStorage blocked — in-memory state still flips so the UI works. */
  }
  apply(next);
  theme.set(next);
}

/** Cycle light → dark → system → light (parity with worker-hub's toggle). */
export function cycleTheme(): void {
  let current: Theme = 'system';
  theme.subscribe((v) => (current = v))();
  const idx = ORDER.indexOf(current);
  setTheme(ORDER[(idx + 1) % ORDER.length] ?? 'system');
}
