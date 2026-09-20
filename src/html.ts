// The design system: escaping, one stylesheet, and the handful of components every page is built
// out of.
//
// Taken from whatsapp2ai's src/html.ts, which is itself imap2ai's design ported out of React and
// Tailwind into a module with no build step. Copied rather than reinterpreted, ON PURPOSE: these
// three products are sold by one person to overlapping customers, and a connector that looks like a
// different company is a connector people wonder about. The tokens below are imap2ai's
// web/src/index.css values, unchanged.
//
// There is no template engine and no build step on purpose: these are a handful of operator and
// account pages, and a dependency plus a compile stage would cost more than it saves. What replaces a
// component library is the second half of this file — `panel`, `stat`, `chip`, `table`, `emptyState`
// — because the alternative is not "simpler markup", it is every page inventing its own padding.
//
// TWO VOCABULARIES, DELIBERATELY. imap2ai keeps its public theme and its admin constitution apart,
// and the reason survives the second port too: a landing page is a brochure and a dashboard is a
// tool. The brochure gets the larger radius, the shadow and the generous type; the tool gets a
// tighter radius, flat panels and a five-rung ladder where every rung is a real step. Anything
// inside `.tool` is the second one. Mixing them is what makes an admin panel look like a marketing
// page with tables in it.

/**
 * HTML-escape. Everything interpolated into a page goes through this — including values that "cannot"
 * contain markup, like a status string, because the day one of them can is the day it is forgotten.
 * Escapes quotes as well as angle brackets so it is safe inside an attribute, not only in text.
 */
export const esc = (s: unknown): string =>
  String(s ?? '')
    // Bidi and other invisible format controls, removed BEFORE escaping. They carry no markup, so
    // they survived the replace below untouched — and a right-to-left override inside text an agent
    // wrote (which means text a language model derived from messages STRANGERS sent) renders its own
    // line mirrored on the supervision dashboard. A figure or a name reading backwards on the one
    // screen whose job is to show you what is happening is not a cosmetic problem.
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A string literal for an inline handler.
 *
 * NOTHING CALLS THIS ANY MORE, and the reason is worth keeping. Two contexts nest inside an
 * onsubmit="confirm(...)" and esc() only handles the outer one: the HTML parser unescapes the
 * attribute BEFORE the JS parser sees it, so an escaped apostrophe comes back as an apostrophe and
 * ends a single-quoted JS string early. A label of "Jure's phone" broke the delete button exactly
 * that way, and this function fixed it.
 *
 * The pages then stopped having inline handlers at all — a form carries data-confirm="…" and
 * /app.js reads it — which removes the nested context and lets the CSP refuse inline script. Kept
 * exported so that anyone who reaches for an inline handler again finds this note first.
 */
export const jsStr = (s: string): string => esc(JSON.stringify(s));

/** Relative time, in the shortest form that is still unambiguous. */
export const ago = (ts: number | null | undefined): string => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** The same, from a Date — which is what Postgres rows carry. */
export const agoDate = (d: Date | string | null | undefined): string =>
  d ? ago(Math.floor(new Date(d).getTime() / 1000)) : 'never';

/** Status colours, for the operator setup page, which is a checklist rather than a table. */
// The meaning ramps, not literals — so a dot means the same thing here as in imap2ai, and follows the
// theme. `busy` is the ink rather than a blue: this design has no accent hue at all.
export const DOT = {
  good: 'hsl(var(--success-600))',
  busy: 'hsl(var(--primary-600))',
  idle: 'hsl(var(--muted-fg))',
  warn: 'hsl(var(--warning-600))',
  bad: 'hsl(var(--error-600))',
} as const;

// Design tokens taken from imap2ai's web/src/index.css, so the two products look like one company.
// Same HSL channel variables, same ramps, and the same inversion in dark — components read the token,
// never a literal, which is why almost nothing below needs a dark-mode rule of its own.
//
// The decision worth preserving, in imap2ai's own words: the primary is "the site's ink, NOT a brand
// blue". It used to be blue-600, and a visitor who clicked through from a monochrome marketing page
// landed on a bright-blue form and had to wonder whether they were still on the same site. On a
// product whose proposition is "trust me with read and write access to your Search Console", looking
// like two companies is not a styling nit. So primary is hue-220 ink. The ramps that carry MEANING — success, warning,
// error — keep their hues, because that is what they are for.
export const CSS = `
:root{
  color-scheme:light dark;
  --primary-600:220 20% 12%; --primary-700:220 25% 7%; --primary-fg:0 0% 100%;
  --bg:210 20% 99%; --fg:222 47% 11%;
  --card:0 0% 100%; --card-fg:222 47% 11%;
  --muted:210 40% 96%; --muted-fg:215 16% 47%;
  --border:214 32% 91%; --input:214 32% 91%; --ring:217 91% 60%;
  /* A second, lighter hairline for separators INSIDE a panel. imap2ai draws panels with
     secondary-200 and table rows with secondary-100 for the same reason: a row divider as strong as
     the panel outline makes a list read as a stack of boxes. */
  --hairline:214 32% 95%;
  --success-50:138 76% 97%; --success-600:142 76% 36%; --success-700:142 72% 29%;
  --warning-50:48 100% 96%; --warning-600:32 95% 44%; --warning-700:26 90% 34%;
  --error-50:0 86% 97%; --error-600:0 72% 51%; --error-700:0 74% 42%;
  /* Two radii, one per vocabulary. The tool's is deliberately smaller than the brochure's — in
     imap2ai's words, tools are tighter than brochures. */
  --radius:0.75rem;
  --radius-tool:0.375rem;
  --shadow-card:0 2px 8px -2px rgba(0,0,0,.05), 0 4px 16px -4px rgba(0,0,0,.08);
  --shadow-button:0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
}
@media(prefers-color-scheme:dark){:root{
  --primary-600:220 14% 90%; --primary-700:220 16% 95%; --primary-fg:220 25% 7%;
  --bg:222 47% 7%; --fg:210 40% 96%;
  --card:222 41% 11%; --card-fg:210 40% 96%;
  --muted:218 33% 16%; --muted-fg:215 18% 60%;
  --border:217 28% 21%; --input:217 28% 24%; --hairline:217 28% 17%;
  --success-50:142 40% 12%; --success-600:142 65% 62%; --success-700:142 65% 70%;
  --warning-50:35 45% 13%; --warning-600:43 95% 62%; --warning-700:43 95% 70%;
  --error-50:0 45% 14%; --error-600:0 90% 70%; --error-700:0 90% 76%;
  --shadow-card:0 2px 8px -2px rgba(0,0,0,.4), 0 4px 16px -4px rgba(0,0,0,.3);
  --shadow-button:0 1px 3px rgba(0,0,0,.3);
}}
*{box-sizing:border-box}
body{
  margin:0;background:hsl(var(--bg));color:hsl(var(--fg));
  /* Inter where it is installed, then the system stack. No webfont: a page that has to wait for a
     download before it is legible is a worse trade than slightly different letterforms. */
  font:0.9375rem/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:44rem;margin:0 auto;padding:2.5rem 1rem 4rem}
.wide{max-width:60rem}
.narrow{max-width:26rem}
h1{font-size:1.5rem;line-height:2rem;letter-spacing:-0.02em;margin:0 0 .25rem;font-weight:600}
h2{font-size:1.0625rem;line-height:1.625rem;letter-spacing:-0.01em;margin:0 0 .625rem;font-weight:600}
h3{font-size:0.9375rem;margin:1.25rem 0 .375rem;font-weight:600}
p{margin:0 0 .75rem}
.muted{color:hsl(var(--muted-fg));font-size:0.8125rem;line-height:1.25rem;letter-spacing:.005em}
.nowrap{white-space:nowrap}
.nowrap.over{color:hsl(var(--error-700));font-weight:500}
.mid{text-align:center}
.mono{font:0.75rem/1.25rem ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
code{font:0.75rem ui-monospace,SFMono-Regular,Menlo,monospace;background:hsl(var(--muted));padding:.125rem .3125rem;border-radius:.25rem;overflow-wrap:anywhere}
pre.jsonbox{
  font:0.75rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:hsl(var(--muted));
  padding:.75rem;border-radius:var(--radius-tool);overflow-x:auto;margin:0;
}
.urlrow{display:flex;gap:.5rem;align-items:center}
.urlrow input{flex:1;min-width:0}
a{color:hsl(var(--fg));text-decoration:underline;text-underline-offset:2px;text-decoration-color:hsl(var(--muted-fg))}
a:hover{text-decoration-color:hsl(var(--fg))}
:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}
footer{color:hsl(var(--muted-fg));font-size:0.75rem;text-align:center;margin-top:2rem}
footer a{color:hsl(var(--muted-fg))}

/* ── the brochure ───────────────────────────────────────────────────────────────────────────────
   Landing, legal and sign-in. Generous, shadowed, 12px corners. */
.card{
  background:hsl(var(--card));color:hsl(var(--card-fg));
  border:1px solid hsl(var(--border));border-radius:var(--radius);
  padding:1.25rem;margin:.875rem 0;box-shadow:var(--shadow-card);
}
.hero{padding:1.5rem 0 .5rem}
.hero h1{font-size:2.125rem;line-height:2.5rem;letter-spacing:-0.03em;margin-bottom:.75rem}
.lede{font-size:1.0625rem;line-height:1.75rem;color:hsl(var(--muted-fg));margin:0 0 1.5rem;max-width:34rem}
.btnrow{display:flex;flex-wrap:wrap;gap:.625rem;align-items:center;margin:0 0 .5rem}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.875rem;margin:.875rem 0}
.cols .card{margin:0}
.steps{counter-reset:step;list-style:none;padding:0;margin:.5rem 0 0}
.steps li{counter-increment:step;position:relative;padding:0 0 .875rem 2rem}
.steps li:last-child{padding-bottom:0}
.steps li::before{
  content:counter(step);position:absolute;left:0;top:.0625rem;
  width:1.375rem;height:1.375rem;border-radius:50%;background:hsl(var(--muted));color:hsl(var(--fg));
  font-size:0.75rem;font-weight:600;display:grid;place-items:center;
}
.prose p,.prose li{color:hsl(var(--fg));font-size:0.875rem;line-height:1.6}
.prose ul{list-style:disc;padding-left:1.125rem;margin:0 0 .75rem}
.prose li{margin:.1875rem 0}
ul.plain{list-style:none;margin:0;padding:0}
li.item{display:flex;gap:.75rem;align-items:flex-start;padding:.6875rem 0;border-bottom:1px solid hsl(var(--border))}
li.item:last-child{border-bottom:0}
li.item p{margin:.1875rem 0 0;color:hsl(var(--muted-fg));font-size:0.8125rem}
.dot{width:.5rem;height:.5rem;border-radius:50%;flex:0 0 .5rem;margin-top:.4375rem;display:inline-block}

/* Controls. The brochure's button is the filled one; the tool re-styles it below. */
label{display:block;font-size:0.8125rem;font-weight:500;margin:.875rem 0 .375rem}
input,textarea{
  width:100%;padding:.625rem .75rem;border:1px solid hsl(var(--input));border-radius:.5rem;
  background:hsl(var(--bg));color:hsl(var(--fg));font:0.9375rem Inter,system-ui,sans-serif;
  transition:border-color 150ms,box-shadow 150ms;
}
input:focus,textarea:focus{outline:none;border-color:hsl(var(--ring));box-shadow:0 0 0 3px hsl(var(--ring)/.15)}
button{
  padding:.625rem 1rem;border:0;border-radius:.5rem;
  background:hsl(var(--primary-600));color:hsl(var(--primary-fg));
  font:500 0.875rem Inter,system-ui,sans-serif;cursor:pointer;
  box-shadow:var(--shadow-button);transition:background 150ms,box-shadow 150ms;
}
button:hover{background:hsl(var(--primary-700))}
button.ghost{background:transparent;color:hsl(var(--muted-fg));border:1px solid hsl(var(--border));box-shadow:none}
button.ghost:hover{background:hsl(var(--muted));color:hsl(var(--fg))}
button.danger{background:transparent;color:hsl(var(--error-600));border:1px solid hsl(var(--border));box-shadow:none}
button.danger:hover{background:hsl(var(--error-50));border-color:hsl(var(--error-600))}
a.button,a.button:hover{
  display:inline-block;padding:.625rem 1.125rem;border-radius:.5rem;
  background:hsl(var(--primary-600));color:hsl(var(--primary-fg));
  font:500 0.875rem Inter,system-ui,sans-serif;box-shadow:var(--shadow-button);text-decoration:none;
}
a.button:hover{background:hsl(var(--primary-700))}
a.button.ghost,a.button.ghost:hover{background:transparent;color:hsl(var(--fg));border:1px solid hsl(var(--border));box-shadow:none}
a.button.ghost:hover{background:hsl(var(--muted))}

/* ── the tool ───────────────────────────────────────────────────────────────────────────────────
   The dashboard, the per-number page and the operator panel. imap2ai's admin constitution, ported:
   one surface level (a panel never contains a panel and never floats), one radius, one hairline,
   one primary action per surface, chips for STATE only, and a type ladder whose five rungs are five
   real sizes — 17 / 15 / 13 / 12 / 11 — because a scale where two rungs are the same size has no
   contrast to read anything against. */
.tool{font-size:0.8125rem;line-height:1.25rem}
.tool h1{font-size:1.0625rem;line-height:1.625rem;letter-spacing:-0.01em;margin:0;font-weight:600}
.tool h2{font-size:0.9375rem;line-height:1.5rem;letter-spacing:0;margin:0;font-weight:600}
.tool h3{font-size:0.8125rem;line-height:1.25rem;margin:0 0 .25rem;font-weight:600}
.tool p{margin:0 0 .625rem;font-size:0.8125rem;line-height:1.25rem}
.tool p:last-child{margin-bottom:0}
.tool .meta{color:hsl(var(--muted-fg));font-size:0.75rem;line-height:1rem}
.tool .micro{color:hsl(var(--muted-fg));font-size:0.6875rem;line-height:1rem}
.tool .muted{font-size:0.75rem;line-height:1rem}
.tool .stack>*+*{margin-top:1.25rem}
.tool a{text-decoration-color:hsl(var(--border))}

/* The one piece of chrome every signed-in page carries: who you are, and the way out. Not a nav —
   there are three pages and two of them are reached from a table row. */
.topbar{
  display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem;
  margin:0 0 1.5rem;padding-bottom:.75rem;border-bottom:1px solid hsl(var(--border));
}
.topbar .brand{font-weight:600;font-size:0.8125rem;text-decoration:none}
.topbar .who{color:hsl(var(--muted-fg));font-size:0.75rem}
.head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem}
.head .grow{min-width:0}
.acts{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}

.panel{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius-tool)}
.panel>header{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.75rem 1rem;border-bottom:1px solid hsl(var(--border))}
.panel>header .meta{margin-top:.125rem}
.panel .body{padding:1rem}
.panel .body>*+*{margin-top:.75rem}
.panel .foot{padding:.75rem 1rem;border-top:1px solid hsl(var(--border));color:hsl(var(--muted-fg));font-size:0.75rem}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.625rem}
.stat{
  display:flex;flex-direction:column;align-items:flex-start;
  background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius-tool);padding:.875rem 1rem;
}
.panel .stat{border:0;background:transparent;padding:0}
.panel .stats{gap:1rem 1.25rem}
.stat .fig{
  font-size:1.375rem;line-height:1.75rem;font-weight:600;letter-spacing:-0.02em;
  font-variant-numeric:tabular-nums;margin-top:.1875rem;
}
.stat .fig.ok{color:hsl(var(--success-700))}
.stat .fig.pending{color:hsl(var(--warning-700))}
.stat .fig.danger{color:hsl(var(--error-700))}

.chip{
  display:inline-flex;align-items:center;gap:.25rem;border-radius:9999px;
  padding:.0625rem .5rem;font-size:0.6875rem;line-height:1rem;font-weight:500;
  white-space:nowrap;border:1px solid transparent;
}
.chip.ok{background:hsl(var(--success-50));color:hsl(var(--success-700));border-color:hsl(var(--success-600)/.3)}
.chip.pending{background:hsl(var(--warning-50));color:hsl(var(--warning-700));border-color:hsl(var(--warning-600)/.35)}
.chip.danger{background:hsl(var(--error-50));color:hsl(var(--error-700));border-color:hsl(var(--error-600)/.3)}
.chip.info{background:hsl(var(--muted));color:hsl(var(--fg));border-color:hsl(var(--border))}

table.t{width:100%;border-collapse:collapse;font-size:0.8125rem}
table.t thead tr{border-bottom:1px solid hsl(var(--border))}
table.t th{padding:.5rem .75rem;text-align:left;font-size:0.75rem;font-weight:500;color:hsl(var(--muted-fg));white-space:nowrap}
table.t td{padding:.625rem .75rem;vertical-align:top}
table.t td{overflow-wrap:anywhere}
table.t tbody tr+tr{border-top:1px solid hsl(var(--hairline))}
table.t .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;width:1px}
table.t th.num{text-align:right}
table.t .end{text-align:right;white-space:nowrap;width:1px}
table.t .lead{font-weight:500}
/* A table is the one thing here that can be wider than the column. It scrolls itself rather than
   pushing the page sideways. */
.scroll{overflow-x:auto}

.empty{padding:2.5rem 1rem;text-align:center}
.empty .t{font-weight:500}
.empty .meta{margin-top:.25rem}

/* Rule 7: a tinted full-width banner is for a BLOCKING state, one per screen. Anything else is a
   line of quiet text. */
.banner{
  display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem;
  border-radius:var(--radius-tool);padding:.75rem 1rem;font-size:0.8125rem;line-height:1.25rem;border:1px solid;
}
.banner.pending{background:hsl(var(--warning-50));color:hsl(var(--warning-700));border-color:hsl(var(--warning-600)/.35)}
.banner.danger{background:hsl(var(--error-50));color:hsl(var(--error-700));border-color:hsl(var(--error-600)/.3)}
.banner.info{background:hsl(var(--muted));color:hsl(var(--fg));border-color:hsl(var(--border))}

/* Rule 3: quiet by default. A screen opts ONE control into .primary. Height is 44px under a finger
   and 32px under a pointer — the touch floor wins on a phone, density wins on a desktop. */
.tool button,.tool a.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:.375rem;
  height:2.75rem;padding:0 .875rem;border-radius:var(--radius-tool);
  background:transparent;color:hsl(var(--fg));border:1px solid hsl(var(--border));box-shadow:none;
  font:500 0.8125rem Inter,system-ui,sans-serif;cursor:pointer;text-decoration:none;white-space:nowrap;
  transition:background 120ms,border-color 120ms,color 120ms;
}
.tool button:hover,.tool a.btn:hover{background:hsl(var(--muted));color:hsl(var(--fg))}
.tool button.primary,.tool a.btn.primary{background:hsl(var(--primary-600));color:hsl(var(--primary-fg));border-color:hsl(var(--primary-600))}
.tool button.primary:hover,.tool a.btn.primary:hover{background:hsl(var(--primary-700));color:hsl(var(--primary-fg))}
.tool button.danger{color:hsl(var(--error-600));background:transparent}
.tool button.danger:hover{background:hsl(var(--error-50));border-color:hsl(var(--error-600)/.5);color:hsl(var(--error-700))}
.tool input,.tool textarea{
  height:2.75rem;border-radius:var(--radius-tool);font-size:1rem;
}
.tool textarea{height:auto}
.tool label{font-size:0.75rem;margin:.75rem 0 .3125rem}
@media(min-width:768px){
  .tool button,.tool a.btn{height:2rem}
  .tool input{height:2rem;font-size:0.8125rem;padding:.25rem .5rem}
}
.tool .rowform{display:inline}
.code{font:600 2rem/1 ui-monospace,monospace;letter-spacing:.18em;margin:.625rem 0}
.err{background:hsl(var(--error-50));color:hsl(var(--error-700));border:1px solid hsl(var(--error-600)/.35);border-radius:.5rem;padding:.75rem;font-size:0.8125rem;margin:.75rem 0}
.note{background:hsl(var(--muted));color:hsl(var(--fg));border:1px solid hsl(var(--border));border-radius:.5rem;padding:.75rem;font-size:0.8125rem;margin:.75rem 0}
.row{display:flex;justify-content:space-between;align-items:center;gap:.75rem;padding:.75rem 0;border-bottom:1px solid hsl(var(--hairline))}
.row:last-child{border-bottom:0}
`;

// ---------------------------------------------------------------- the components

export type State = 'ok' | 'pending' | 'danger' | 'info';

/** The one <h1> a page has, its subtitle, and the one primary action. */
export function pageHeader(o: { title: string; meta?: string; action?: string; back?: { href: string; label: string } }): string {
  return `<div class="head">
    <div class="grow">
      ${o.back ? `<p class="meta" style="margin:0 0 .25rem"><a href="${esc(o.back.href)}">← ${esc(o.back.label)}</a></p>` : ''}
      <h1>${esc(o.title)}</h1>
      ${o.meta ? `<p class="meta" style="margin:.125rem 0 0">${o.meta}</p>` : ''}
    </div>
    ${o.action ? `<div class="acts">${o.action}</div>` : ''}
  </div>`;
}

/**
 * A bordered region of the page. One surface level: a panel never contains another panel and never
 * floats — `flush` is for a table, which draws its own separators and would otherwise sit inside a
 * second, smaller box.
 */
export function panel(o: { title?: string; meta?: string; action?: string; body: string; flush?: boolean; foot?: string }): string {
  const header =
    o.title || o.meta || o.action
      ? `<header><div class="grow">${o.title ? `<h2>${esc(o.title)}</h2>` : ''}${
          o.meta ? `<p class="meta" style="margin:0">${o.meta}</p>` : ''
        }</div>${o.action ?? ''}</header>`
      : '';
  return `<section class="panel">${header}${o.flush ? o.body : `<div class="body">${o.body}</div>`}${
    o.foot ? `<div class="foot">${o.foot}</div>` : ''
  }</section>`;
}

/** A figure worth reading as a shape. `state` colours the NUMBER — only when the number is a state. */
export function stat(o: { label: string; value: string | number; meta?: string; state?: State }): string {
  return `<div class="stat">
    <span class="meta">${esc(o.label)}</span>
    <span class="fig${o.state && o.state !== 'info' ? ' ' + o.state : ''}">${esc(o.value)}</span>
    ${o.meta ? `<span class="meta" style="margin-top:.125rem">${o.meta}</span>` : ''}
  </div>`;
}

export const stats = (...tiles: string[]): string => `<div class="stats">${tiles.join('')}</div>`;

/** The only pill on these pages, and it means a state — never a role, a type or a plain fact. */
export const chip = (state: State, text: string): string => `<span class="chip ${state}">${esc(text)}</span>`;

/** One per screen, for something that BLOCKS. Everything quieter is a line of text. */
export const banner = (state: State, html: string, action = ''): string =>
  `<div class="banner ${state}"><div>${html}</div>${action}</div>`;

export function emptyState(o: { title: string; meta?: string; action?: string }): string {
  return `<div class="empty">
    <p class="t" style="margin:0">${esc(o.title)}</p>
    ${o.meta ? `<p class="meta" style="margin:.25rem 0 0">${o.meta}</p>` : ''}
    ${o.action ? `<div style="margin-top:.875rem">${o.action}</div>` : ''}
  </div>`;
}

export interface Column {
  header: string;
  /** Right-aligned and tabular — for anything a reader compares down the column. */
  num?: boolean;
  /** Pinned to the right and never wrapped: the row's actions. */
  end?: boolean;
}

/**
 * Hairline separators, no zebra, no per-row cards. Cells are raw HTML because a cell is routinely
 * two rungs of type, which no `value: string` signature survives — every caller escapes its own text.
 */
export function table(columns: Column[], rows: string[][], empty?: string): string {
  if (!rows.length) return empty ?? emptyState({ title: 'Nothing here yet' });
  const cls = (c: Column) => (c.num ? ' class="num"' : c.end ? ' class="end"' : '');
  return `<div class="scroll"><table class="t">
    <thead><tr>${columns.map((c) => `<th${cls(c)} scope="col">${esc(c.header)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr>${r.map((cell, i) => `<td${cls(columns[i] ?? {} as Column)}>${cell}</td>`).join('')}</tr>`)
      .join('')}</tbody>
  </table></div>`;
}

/**
 * The tab icon, inline. A file would be a second request and a route to serve it; a data URI is
 * neither, and there is no build step here to put one in. Two lines in a rounded square — legible at
 * 16px, which a logo with any detail in it is not, and nothing that borrows WhatsApp's mark.
 */
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="8" fill="#131a26"/>' +
      // Three rising bars: search analytics, which is what this connector is for. Same square, same
      // ink and same weight as its siblings' marks, so the three read as a set in a tab strip --
      // and nothing borrowing Google's colours, which would imply an endorsement that does not exist.
      '<path d="M10 21.5v-4M16 21.5v-8M22 21.5v-11" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>' +
      '</svg>',
  );

export interface PageOptions {
  /** Seconds. Adds a meta refresh — used by pages that are watching something change. */
  refresh?: number;
  /** Constrains the column, for sign-in and link pages. */
  narrow?: boolean;
  /** Widens it, for the operator panel's tables. */
  wide?: boolean;
  /** Opts the page into the tool vocabulary: flat panels, tighter radius, the five-rung ladder. */
  tool?: boolean;
  /** Extra rules for one page only. Anything reused belongs in CSS above instead. */
  extraCss?: string;
  /** One sentence for search results and link previews. Only the public pages need it. */
  description?: string;
  /** Footer line. Small print and version stamps, in the same place on every page. */
  footer?: string;
}

/** The shell every page shares: charset, viewport, one stylesheet, one wrapper. */
export function page(title: string, body: string, o: PageOptions = {}): string {
  const classes = ['wrap', o.narrow ? 'narrow' : '', o.wide ? 'wide' : '', o.tool ? 'tool' : ''].filter(Boolean).join(' ');
  return (
    // lang is on the element rather than assumed: it is what tells a screen reader which language to
    // pronounce, and every page here is English even where the content it shows is not.
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    (o.description ? `<meta name="description" content="${esc(o.description)}">` : '') +
    `<link rel="icon" href="${FAVICON}">` +
    (o.refresh ? `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(o.refresh))}">` : '') +
    `<style>${CSS}${o.extraCss ?? ''}</style>` +
    // Same origin, deferred, on every page — the only script any of these pages runs, which is what
    // lets the CSP refuse inline script entirely. See SECURITY_HEADERS.
    `<script src="/app.js" defer></script>` +
    `<div class="${classes}">${body}` +
    (o.footer ? `<footer>${o.footer}</footer>` : '') +
    `</div></html>`
  );
}

/**
 * Response headers for every page. Cheap, and each one closes something specific: nosniff stops a
 * text response being run as script, DENY stops the dashboard being framed and clicked through,
 * no-referrer keeps a connector URL out of another site's logs if one ever appears in a link, and the
 * policy says this server loads nothing from anywhere else — there is no CDN, no font, no analytics.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // `script-src 'self'` and NOT 'unsafe-inline'. That is the whole reason APP_JS exists as a file
  // instead of six onclick/onsubmit attributes and one <script> block: with 'unsafe-inline' any HTML
  // injection on a page runs, and these pages carry same-origin POST routes that turn on sending,
  // turn on the unattended agent, mint a connector URL and delete a number. No injection is known —
  // the escaping is mutation-tested — but this is the mitigation for the one nobody has found yet,
  // and a policy that allows every inline script is not a policy.
  //
  // A nonce would work too and is worse here: it has to be threaded through every page function, and
  // one page that forgets it silently loses its scripts. A file cannot be forgotten.
  //
  // `style-src` keeps 'unsafe-inline' deliberately. The markup uses style="" attributes throughout,
  // which that directive also governs; CSS is not execution, and `default-src 'none'` with
  // `img-src 'self' data:` already blocks the exfiltration routes a stylesheet could otherwise take.
  // form-action lists accounts.google.com as well as 'self', and it has to.
  //
  // CHROME APPLIES form-action TO EVERY HOP OF A REDIRECT CHAIN, not just the URL in the form's
  // action attribute. "Add a property" posts to /app/accounts, which redirects to
  // /oauth/google/start, which redirects to Google's consent screen — and that last hop is not
  // 'self', so Chrome refused the whole submission. The symptom is the worst kind: the button does
  // NOTHING, no error, no navigation, and the only evidence is a line in the Issues panel.
  // (Firefox submits it; the two browsers read the spec differently.)
  //
  // Widened to exactly one host rather than dropped: accounts.google.com is the only cross-origin
  // place any form here may end up, and 'self' still covers everything else.
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self'; " +
    "form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'",
};

/**
 * Every line of client-side script these pages have, served as one file from the same origin.
 *
 * It is deliberately tiny and entirely declarative in what it looks for: a form with data-confirm
 * asks before submitting, a button with data-copy copies the element it names, and the reset page's
 * token is lifted out of the URL fragment. Nothing here reads or writes anything else, so a page can
 * gain a confirm dialog by adding an attribute rather than an inline handler.
 */
export const APP_JS = `(function () {
  'use strict';

  document.addEventListener('submit', function (e) {
    // The submit event's target is always the FORM, so an attribute on a button would be read by
    // nothing and fail silently — and for a confirm dialog, silent means the guard is simply absent.
    var f = e.target;
    var m = (f.getAttribute && f.getAttribute('data-confirm')) ||
      (e.submitter && e.submitter.getAttribute && e.submitter.getAttribute('data-confirm'));
    if (m && !window.confirm(m)) e.preventDefault();
  });

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy]');
    if (!b) return;
    var el = document.getElementById(b.getAttribute('data-copy'));
    if (!el) return;
    // navigator.clipboard is undefined outside a secure context — a self-hosted deploy on plain
    // http — so this must not throw inside a delegated listener or leave a rejection unhandled.
    if (!navigator.clipboard) { b.textContent = 'Select and copy'; return; }
    navigator.clipboard.writeText(el.value || el.textContent).then(
      function () { b.textContent = 'Copied'; },
      function () { b.textContent = 'Select and copy'; }
    );
  });

  // Both listeners above need only \`document\`, which exists while the page is still parsing —
  // which is why this script is not deferred. This part reads elements, so it is the one part that
  // waits for them.
  document.addEventListener('DOMContentLoaded', function () {
    // The password-reset link carries its token in the URL fragment, which never reaches the server.
    var t = document.getElementById('reset-token');
    if (!t) return;
    var tok = new URLSearchParams(location.hash.slice(1)).get('access_token');
    if (tok) {
      t.value = tok;
      // Out of the address bar and out of history. It is still in this page, which is where it has
      // to be, but it will not be in the next screenshot or the next shared URL.
      history.replaceState(null, '', location.pathname);
    } else {
      var no = document.getElementById('nolink');
      var card = document.getElementById('card');
      if (no) no.hidden = false;
      if (card) card.hidden = true;
    }
  });
})();
`;
