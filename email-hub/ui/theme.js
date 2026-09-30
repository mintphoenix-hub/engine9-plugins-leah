/*
  Make the hub's screens look like the site they are mounted in, and keep doing so.

    import { applyTheme } from './theme.js';
    const theme = applyTheme(root);                  // reads the page, sets the --eh-* variables on `root`
    theme.refresh();                                 // read the page again (it also does this by itself, see below)
    theme.stop();                                    // remove everything applyTheme attached
    mountEmailHub(root, { theme: true })             // the usual way: the screens call applyTheme for you

  What it reads, in this order of trust:
    1. `vars`       what the host set explicitly. Always wins, key by key.
    2. `hints`      selectors of real elements to sample: { accent, primary, heading, panel } (any of them). A site whose
                    buttons are styled by a class says so here: hints: { primary: '.btn-primary' }.
    3. the page's own custom properties, by the common names (--primary, --accent, --background, --foreground, --card,
       --border, --radius, --font-sans), in a plain color or the "H S% L%" triple many design systems use.
    4. computed styles: the page background (the nearest ancestor of `root` that is not transparent), the text color, the
       font, the base type size, a link's color, a button's fill and corners, a heading's font and case.
  Everything derived is checked for contrast: text on a surface is at least 4.5:1, an accent is at least 3:1 against the
  surface, and a fill's label is whichever of black and white reads better. A dark site gets a dark hub; a light one, a light hub.

  It re-reads the page when the site changes its look: a class, style or data-theme change on <html> or <body>, the
  visitor's light/dark setting, and web fonts finishing loading (debounced, so a burst of changes is one read).

  This file has NO side effects when imported. Nothing is read, observed or listened to until applyTheme is called, and
  stop() undoes all of it.

  The color and contrast helpers are exported and pure, so they are tested without a browser (theme.test.mjs).
*/

/* ---- colors: pure ---------------------------------------------------------------------------- */

const clamp = (n, lo = 0, hi = 255) => Math.min(hi, Math.max(lo, n));

/* Any of: #rgb #rrggbb, rgb()/rgba() (comma or space form), hsl()/hsla(), or a bare "H S% L%" triple. null when not a color. */
export function parseColor(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'currentcolor' || s === 'initial' || s === 'none') return null;
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const ch = (v) => (v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v));
    const al = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: clamp(Math.round(ch(m[1]))), g: clamp(Math.round(ch(m[2]))), b: clamp(Math.round(ch(m[3]))), a: clamp(al, 0, 1) };
  }
  m = /^(?:hsla?\(\s*)?([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)?$/.exec(s);
  if (m) {
    const h = ((parseFloat(m[1]) % 360) + 360) % 360, sat = clamp(parseFloat(m[2]) / 100, 0, 1), l = clamp(parseFloat(m[3]) / 100, 0, 1);
    const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), mm = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const al = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: Math.round((r + mm) * 255), g: Math.round((g + mm) * 255), b: Math.round((b + mm) * 255), a: clamp(al, 0, 1) };
  }
  return null;
}

/* An opaque color, or null when it is fully transparent (which means "look further up"). */
export const opaque = (c) => (c && c.a > 0.02 ? c : null);

export const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => clamp(Math.round(v)).toString(16).padStart(2, '0')).join('')}`;
export const rgba = ({ r, g, b }, a) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

/* Flatten a translucent color onto a background. */
export const over = (c, bg) => ({ r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a), a: 1 });

/* WCAG relative luminance and contrast ratio. */
export function luminance({ r, g, b }) {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export const isDark = (c) => luminance(c) < 0.35;

/* t of the way from a to b. */
export const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });

const BLACK = { r: 0, g: 0, b: 0, a: 1 }, WHITE = { r: 255, g: 255, b: 255, a: 1 };

/* Black or white, whichever reads better on `bg`. */
export const readableOn = (bg) => (contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK);

/* Move `fg` toward the readable extreme until it reaches `ratio` against `bg` (or gives up at the extreme). */
export function ensureContrast(fg, bg, ratio) {
  if (contrast(fg, bg) >= ratio) return fg;
  const target = readableOn(bg);
  let out = fg;
  for (let i = 1; i <= 20; i++) { out = mix(fg, target, i / 20); if (contrast(out, bg) >= ratio) return out; }
  return out;
}

/* ---- the theme: pure ------------------------------------------------------------------------- */

const FONT = /^[\w\s'",.\-]+$/;   // a font-family list, nothing that could carry markup or a url()

/*
  `page` is what was read from the page (see readPage): { bg, ink, font, scale, link, button, buttonText, radius,
  headingFont, headingCase, headingTracking, panel, border, accent, primary }. Any of them may be missing; every
  missing one is derived. Returns { vars, info } where vars is the --eh-* map.
*/
export function themeFrom(page = {}) {
  const bg = opaque(page.bg) || WHITE;
  const dark = isDark(bg);
  const ink0 = opaque(page.ink) || (dark ? WHITE : BLACK);
  const ink = ensureContrast(ink0, bg, 4.5);
  const panel = opaque(page.panel) || (dark ? mix(bg, WHITE, 0.06) : (luminance(bg) > 0.9 ? WHITE : mix(bg, WHITE, 0.6)));
  const panel2 = mix(panel, ink, 0.07);
  const inkOnPanel = ensureContrast(ink, panel, 4.5);
  const soft = ensureContrast(mix(inkOnPanel, panel, 0.35), panel, 4.5);
  const accent0 = opaque(page.accent) || opaque(page.link) || opaque(page.primary) || mix(ink, panel, 0.2);
  const accent = ensureContrast(accent0, panel, 3);
  const primary0 = opaque(page.primary) || opaque(page.button) || accent0;
  const primary = primary0;   // a fill may be any color: only its label has to read, and readableOn picks that
  const rule = opaque(page.border) ? (over(page.border, panel)) : mix(panel, ink, 0.18);
  const vars = {
    '--eh-page': toHex(bg), '--eh-panel': toHex(panel), '--eh-panel-2': toHex(panel2), '--eh-ink': toHex(inkOnPanel), '--eh-soft': toHex(soft),
    '--eh-rule': toHex(rule), '--eh-accent': toHex(accent), '--eh-on-accent': toHex(readableOn(accent)), '--eh-accent-tint': toHex(mix(panel, accent, 0.14)),
    '--eh-primary': toHex(primary), '--eh-on-primary': toHex(readableOn(primary)),
    '--eh-alt': toHex(primary), '--eh-on-alt': toHex(readableOn(primary)), '--eh-alt-tint': toHex(mix(panel, primary, 0.14)),
    '--eh-danger': dark ? '#e58aa0' : '#b04a4a',
  };
  if (page.font && FONT.test(page.font)) vars['--eh-font'] = page.font;
  if (Number.isFinite(page.radius)) vars['--eh-radius'] = `${clamp(Math.round(page.radius), 0, 24)}px`;
  if (Number.isFinite(page.scale) && page.scale > 0.75 && page.scale < 1.5) vars['--eh-scale'] = String(Math.round(page.scale * 100) / 100);
  if (page.headingFont && FONT.test(page.headingFont)) vars['--eh-heading-font'] = page.headingFont;
  if (page.headingCase === 'uppercase' || page.headingCase === 'none' || page.headingCase === 'capitalize') vars['--eh-heading-transform'] = page.headingCase;
  if (page.headingTracking && /^-?[\d.]+(px|em|rem)$/.test(page.headingTracking)) vars['--eh-heading-tracking'] = page.headingTracking;
  return { vars, info: { dark, contrastInk: Math.round(contrast(inkOnPanel, panel) * 10) / 10, contrastAccent: Math.round(contrast(accent, panel) * 10) / 10 } };
}

/* ---- reading the page: needs a DOM ------------------------------------------------------------ */

const CUSTOM = {
  bg: ['--background', '--bg', '--color-background', '--color-bg', '--surface'],
  ink: ['--foreground', '--text', '--color-text', '--color-foreground', '--body-color'],
  panel: ['--card', '--color-card', '--panel', '--surface-2'],
  border: ['--border', '--color-border', '--rule'],
  accent: ['--accent', '--color-accent', '--link', '--color-link'],
  primary: ['--primary', '--color-primary', '--brand'],
};

export function readPage(root, { hints = {}, win = globalThis.window } = {}) {
  const doc = win.document, gcs = (el) => win.getComputedStyle(el);
  const host = root.parentElement || doc.body;
  const css = (el, prop) => gcs(el).getPropertyValue(prop).trim();
  const custom = (names) => {
    for (const n of names) { const c = parseColor(css(doc.documentElement, n)); if (c) return c; }
    return null;
  };
  /* Only the SITE's own elements: the hub's own buttons and headings would feed its look back into itself. */
  const outside = (e) => !!e && !root.contains(e);
  const sample = (sel) => { try { if (!sel) return null; const all = doc.querySelectorAll ? [...doc.querySelectorAll(sel)] : [doc.querySelector(sel)]; return all.find(outside) || null; } catch (_) { return null; } };
  const out = {};

  /* Background: the nearest ancestor with a fill; else the page's own variable; else white. */
  let el = host, bg = null;
  while (el && !bg) { bg = opaque(parseColor(css(el, 'background-color'))); el = el.parentElement; }
  out.bg = bg || custom(CUSTOM.bg) || opaque(parseColor(css(doc.documentElement, 'background-color'))) || null;
  const hostStyle = gcs(host);
  out.ink = opaque(parseColor(hostStyle.color)) || custom(CUSTOM.ink);
  out.font = hostStyle.fontFamily || null;
  const px = parseFloat(hostStyle.fontSize);
  out.scale = Number.isFinite(px) && px > 0 ? px / 16 : null;

  out.panel = custom(CUSTOM.panel);
  const panelEl = sample(hints.panel); if (panelEl) out.panel = opaque(parseColor(css(panelEl, 'background-color'))) || out.panel;
  out.border = custom(CUSTOM.border);
  out.accent = custom(CUSTOM.accent);
  out.primary = custom(CUSTOM.primary);

  /* Links, buttons and headings: real elements where there are some, or the ones the host points to. */
  const link = sample(hints.accent) || (() => { const a = doc.createElement('a'); a.href = '#'; a.style.display = 'none'; host.appendChild(a); a.__eh = true; return a; })();
  out.link = opaque(parseColor(css(link, 'color')));
  // A site whose links are just its body color (no accent of their own) has nothing to say here: fall back to its button or primary.
  if (out.link && out.ink && contrast(out.link, out.ink) < 1.3) out.link = null;
  if (link.__eh) link.remove();
  if (hints.accent && !out.accent) out.accent = out.link;
  const btn = sample(hints.primary) || null;
  if (btn) {
    out.button = opaque(parseColor(css(btn, 'background-color'))) || opaque(parseColor(css(btn, 'color')));
    const r = parseFloat(css(btn, 'border-top-left-radius')); if (Number.isFinite(r)) out.radius = r;
  }
  if (!Number.isFinite(out.radius)) {
    const r = parseFloat(css(doc.documentElement, '--radius')) * (/rem$/.test(css(doc.documentElement, '--radius')) ? 16 : 1);
    if (Number.isFinite(r)) out.radius = r;
  }
  const h = sample(hints.heading) || sample('h1, h2');
  if (h) {
    const hs = gcs(h);
    out.headingFont = hs.fontFamily || null; out.headingCase = hs.textTransform || null;
    out.headingTracking = hs.letterSpacing && hs.letterSpacing !== 'normal' ? hs.letterSpacing : null;
  }
  return out;
}

/* ---- applying it, and keeping it current --------------------------------------------------------- */

/*
  options: { vars, hints, observe = true, win }. Returns { refresh, stop, vars }.
  `vars` are applied last, so a host's explicit choice always wins.
*/
export function applyTheme(root, options = {}) {
  const win = options.win || globalThis.window;
  const applied = new Set();
  let timer = null, stopped = false, observer = null, media = null, onMedia = null, onFonts = null;
  const set = (k, v) => { root.style.setProperty(k, v); applied.add(k); };

  function refresh() {
    if (stopped) return null;
    let result;
    try { result = themeFrom(readPage(root, { hints: options.hints || {}, win })); } catch (_) { result = { vars: {}, info: {} }; }
    const vars = Object.assign({}, result.vars, options.vars || {});
    for (const k of applied) if (!(k in vars)) { root.style.removeProperty(k); applied.delete(k); }
    Object.keys(vars).forEach((k) => set(k, vars[k]));
    api.vars = vars; api.info = result.info;
    return vars;
  }
  const soon = () => { if (timer) win.clearTimeout(timer); timer = win.setTimeout(refresh, 150); };

  if (options.observe !== false) {
    if (typeof win.MutationObserver === 'function') {
      observer = new win.MutationObserver(soon);
      const cfg = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode', 'data-color-scheme'] };
      observer.observe(win.document.documentElement, cfg);
      if (win.document.body) observer.observe(win.document.body, cfg);
    }
    if (typeof win.matchMedia === 'function') {
      media = win.matchMedia('(prefers-color-scheme: dark)');
      onMedia = soon;
      if (media.addEventListener) media.addEventListener('change', onMedia); else if (media.addListener) media.addListener(onMedia);
    }
    if (win.document.fonts && win.document.fonts.ready && typeof win.document.fonts.ready.then === 'function') {
      onFonts = true; win.document.fonts.ready.then(() => { if (!stopped) soon(); }).catch(() => {});
    }
  }

  function stop() {
    stopped = true;
    if (timer) win.clearTimeout(timer);
    if (observer) observer.disconnect();
    if (media && onMedia) { if (media.removeEventListener) media.removeEventListener('change', onMedia); else if (media.removeListener) media.removeListener(onMedia); }
    for (const k of applied) root.style.removeProperty(k);
    applied.clear();
    void onFonts;
  }

  const api = { refresh, stop, vars: {}, info: {} };
  refresh();
  return api;
}
