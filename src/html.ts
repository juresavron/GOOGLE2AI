// Escaping and the handful of headers every response carries. Kept as its own module from the start
// because its siblings' page layers grew out of exactly this file, and both of them had to unpick a
// copy of `esc` from two page modules first.

/**
 * HTML-escape. Everything interpolated into a page goes through this — including values that
 * "cannot" contain markup, because the day one of them can is the day it is forgotten. Quotes are
 * escaped too, so it is safe inside an attribute and not only in text.
 */
export const esc = (s: unknown): string =>
  String(s ?? '')
    // Bidi and other invisible format controls, removed BEFORE escaping: they carry no markup, so
    // they would survive the replace below untouched, and a right-to-left override inside a search
    // term (which is text STRANGERS typed into Google) renders its line mirrored on the setup page.
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Response headers for every page. Cheap, and each one closes something specific: nosniff stops a
 * text response being run as script, DENY stops a page being framed and clicked through, no-referrer
 * keeps the connector URL — which IS the credential — out of another site's logs if it ever appears
 * in a link, and the policy says this server loads nothing from anywhere else.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const STYLE =
  'font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem;color:#1a1a1a;background:#fff';

/** Wrap a fragment in the one page shell this stage needs. Stage 4 replaces it with real pages. */
export const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title></head><body style="${STYLE}">${body}</body></html>`;

/**
 * Every line of client-side script these pages have, served as one file from the same origin.
 *
 * A file rather than inline handlers, which is what lets the CSP refuse inline script outright: with
 * 'unsafe-inline' any HTML injection on a page runs, and these pages carry same-origin POST routes
 * that mint a connector URL and delete an account. It is also why the delete button carries
 * data-confirm="..." instead of onsubmit="confirm(...)" — an attribute has two nested parsing
 * contexts and esc() only handles the outer one, so a label containing an apostrophe broke the
 * button in whatsapp2ai exactly that way.
 */
export const APP_JS = `(function () {
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && f.dataset && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
  });
})();`;
