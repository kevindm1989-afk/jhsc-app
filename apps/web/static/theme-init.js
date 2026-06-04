/* global localStorage, document */
/*
 * Theme bootstrap — runs synchronously in <head> BEFORE first paint so an
 * explicit light/dark choice that differs from the OS preference does not
 * flash the wrong palette (FOUC). CSP-safe: served same-origin, covered by
 * `script-src 'self'` (no inline script, no third-party JS — ADR-0010).
 *
 * Contract:
 *   - localStorage['jhsc:theme'] === 'light' | 'dark'  → set <html data-theme>
 *     so the token override in app.html's boot CSS wins over the OS media query.
 *   - anything else ('system' or unset) → remove the attribute and let
 *     `@media (prefers-color-scheme: …)` govern (the default, no-flash path).
 *
 * Fails open: if localStorage is blocked (private mode), we fall back to the
 * prefers-color-scheme default — the app stays usable.
 */
(function () {
  try {
    var t = localStorage.getItem('jhsc:theme');
    var el = document.documentElement;
    if (t === 'light' || t === 'dark') {
      el.setAttribute('data-theme', t);
    } else {
      el.removeAttribute('data-theme');
    }
  } catch {
    /* localStorage unavailable — prefers-color-scheme handles it. */
  }
})();
