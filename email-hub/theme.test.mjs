import assert from 'node:assert/strict';
import { parseColor, toHex, contrast, luminance, isDark, readableOn, ensureContrast, mix, themeFrom, readPage, applyTheme } from './ui/theme.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };

console.log('colors');
{
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(toHex(parseColor('#0C0712')), '#0c0712');
  assert.deepEqual(parseColor('rgb(12, 7, 18)'), { r: 12, g: 7, b: 18, a: 1 });
  assert.deepEqual(parseColor('rgb(12 7 18 / 50%)'), { r: 12, g: 7, b: 18, a: 0.5 });
  assert.equal(parseColor('rgba(0, 0, 0, 0)').a, 0);
  assert.equal(toHex(parseColor('hsl(0 100% 50%)')), '#ff0000');
  assert.equal(toHex(parseColor('222.2 84% 4.9%')), toHex(parseColor('hsl(222.2, 84%, 4.9%)')), 'the bare "H S% L%" triple design systems use');
  for (const bad of ['', null, 'transparent', 'currentcolor', 'red', 'url(x)', 'var(--x)', '#12']) assert.equal(parseColor(bad), null, String(bad));
  ok('colors are read in hex, rgb, hsl and the bare triple, and anything else is refused');
}
{
  const W = parseColor('#fff'), B = parseColor('#000');
  assert.equal(Math.round(contrast(W, B)), 21); assert.ok(contrast(W, W) < 1.01);
  assert.equal(isDark(parseColor('#0c0712')), true); assert.equal(isDark(parseColor('#f5f9f8')), false);
  assert.equal(toHex(readableOn(parseColor('#0c0712'))), '#ffffff'); assert.equal(toHex(readableOn(parseColor('#f5f9f8'))), '#000000');
  const weak = ensureContrast(parseColor('#777777'), parseColor('#808080'), 4.5); assert.ok(contrast(weak, parseColor('#808080')) >= 4.5 || contrast(weak, parseColor('#808080')) > contrast(parseColor('#777777'), parseColor('#808080')));
  assert.equal(toHex(ensureContrast(parseColor('#ffffff'), parseColor('#0c0712'), 4.5)), '#ffffff', 'already readable: untouched');
  assert.ok(luminance(mix(W, B, 0.5)) > 0.1 && luminance(mix(W, B, 0.5)) < 0.3);
  ok('contrast is worked out, labels pick black or white, and a weak color is moved until it reads');
}

console.log('the theme');
{
  const dark = themeFrom({ bg: parseColor('#0c0712'), ink: parseColor('#f1e8dc'), link: parseColor('#e8c97a'), button: parseColor('#8a1538'), font: "'Source Sans 3', sans-serif", scale: 1.1, radius: 6 });
  assert.equal(dark.info.dark, true);
  assert.equal(dark.vars['--eh-page'], '#0c0712'); assert.equal(dark.vars['--eh-accent'], '#e8c97a'); assert.equal(dark.vars['--eh-primary'], '#8a1538');
  assert.equal(dark.vars['--eh-on-primary'], '#ffffff'); assert.equal(dark.vars['--eh-radius'], '6px'); assert.equal(dark.vars['--eh-scale'], '1.1');
  assert.ok(dark.info.contrastInk >= 4.5 && dark.info.contrastAccent >= 3);
  assert.ok(luminance(parseColor(dark.vars['--eh-panel'])) > luminance(parseColor(dark.vars['--eh-page'])), 'a dark site\'s cards are a step lighter than its page');
  const light = themeFrom({ bg: parseColor('#f5f9f8'), ink: parseColor('#1b3834'), link: parseColor('#274f49') });
  assert.equal(light.info.dark, false); assert.equal(light.vars['--eh-panel'], '#ffffff'); assert.equal(light.vars['--eh-danger'], '#b04a4a');
  assert.ok(!('--eh-font' in light.vars) && !('--eh-radius' in light.vars), 'nothing invented that the page did not say');
  const bare = themeFrom({}); assert.equal(bare.vars['--eh-page'], '#ffffff'); assert.ok(bare.info.contrastInk >= 4.5);
  const bad = themeFrom({ bg: parseColor('#fff'), font: 'x; background:url(//evil)', headingFont: 'a{b}', headingCase: 'weird', headingTracking: '1;2', scale: 9 });
  for (const k of ['--eh-font', '--eh-heading-font', '--eh-heading-transform', '--eh-heading-tracking', '--eh-scale']) assert.ok(!(k in bad.vars), k);
  const low = themeFrom({ bg: parseColor('#ffffff'), ink: parseColor('#cccccc'), link: parseColor('#dddddd') });
  assert.ok(low.info.contrastInk >= 4.5 && low.info.contrastAccent >= 3, 'a page with weak colors still gets a readable hub');
  ok('a dark site gets a dark hub and a light one a light hub, every text and accent is readable, and nothing unsafe or unsaid is set');
}

console.log('reading a page');
/* A tiny DOM: elements with a parent, computed styles from a table, custom properties on <html>. */
function fakeWin({ styles = {}, vars = {}, htmlBg = '', dataBg = 'rgba(0, 0, 0, 0)', selectors = {} } = {}) {
  const mk = (name, parent = null) => ({ name, parentElement: parent, style: { setProperty(k, v) { this._p = this._p || {}; this._p[k] = v; }, removeProperty(k) { delete (this._p || {})[k]; }, display: '' }, remove() { this.gone = true; }, appendChild(c) { c.parentElement = this; return c; } });
  const html = mk('html'), body = mk('body', html), main = mk('main', body), root = mk('root', main);
  const observed = []; const listeners = [];
  const win = {
    document: {
      documentElement: html, body, fonts: null,
      createElement: (t) => mk(t), querySelector: (sel) => (selectors[sel] || [])[0] || null, querySelectorAll: (sel) => selectors[sel] || [],
    },
    getComputedStyle: (el) => {
      // color, font and size inherit down the tree, as in a browser
      const inherited = (e, k) => { for (let x = e; x; x = x.parentElement) { const v = (styles[x.name] || {})[k]; if (v) return v; } return ''; };
      const st = Object.assign({}, styles[el.name] || {}, { color: inherited(el, 'color'), fontFamily: inherited(el, 'fontFamily'), fontSize: inherited(el, 'fontSize') || '16px' });
      return { color: st.color || '', fontFamily: st.fontFamily || '', fontSize: st.fontSize || '16px', textTransform: st.textTransform || 'none', letterSpacing: st.letterSpacing || 'normal',
        fontFamilyRaw: st.fontFamily, getPropertyValue: (p) => (el === html && vars[p]) || (st[p]) || (p === 'background-color' ? (el === html ? htmlBg : (st.bg || dataBg)) : '') };
    },
    MutationObserver: class { constructor(cb) { this.cb = cb; observed.push(this); } observe() {} disconnect() { this.off = true; } },
    matchMedia: () => ({ addEventListener: (e, cb) => listeners.push(cb), removeEventListener: (e, cb) => listeners.splice(listeners.indexOf(cb), 1) }),
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
  };
  return { win, root, observed, listeners, html, body };
}
{
  const f = fakeWin({ styles: { body: { bg: 'rgb(12, 7, 18)', color: 'rgb(241, 232, 220)', fontFamily: '"Josefin Sans", sans-serif', fontSize: '17.6px', 'background-color': 'rgb(12, 7, 18)' }, a: {} }, vars: { '--primary': '342 82% 30%', '--radius': '0.375rem' } });
  const page = readPage(f.root, { win: f.win });
  assert.equal(toHex(page.bg), '#0c0712'); assert.equal(toHex(page.ink), '#f1e8dc'); assert.equal(page.scale, 1.1);
  assert.equal(toHex(page.primary).length, 7); assert.equal(page.radius, 6);
  ok('the page is read: its background from the nearest filled ancestor, its text, size, and the design system\'s own variables');
}
{
  const f = fakeWin({ styles: { body: { 'background-color': 'rgb(12, 7, 18)', color: 'rgb(241, 232, 220)' } } });
  const t = applyTheme(f.root, { win: f.win, vars: { '--eh-radius': '0px' } });
  assert.equal(t.vars['--eh-page'], '#0c0712'); assert.equal(t.vars['--eh-radius'], '0px', 'the host\'s explicit value wins');
  assert.equal(f.root.style._p['--eh-page'], '#0c0712');
  assert.equal(f.observed.length >= 1 && f.listeners.length, 1, 'it watches the page and the light/dark setting');
  // the site changes its look: the hub follows
  f.win.getComputedStyle = ((orig) => (el) => { const r = orig(el); if (el.name === 'body') return { ...r, getPropertyValue: (p) => (p === 'background-color' ? 'rgb(255, 255, 255)' : ''), color: 'rgb(20, 20, 20)' }; return r; })(f.win.getComputedStyle);
  t.refresh(); assert.equal(f.root.style._p['--eh-page'], '#ffffff'); assert.equal(f.root.style._p['--eh-radius'], '0px');
  t.stop();
  assert.deepEqual(f.root.style._p, {}, 'stop removes everything it set'); assert.equal(f.observed[0].off, true); assert.equal(f.listeners.length, 0);
  assert.equal(t.refresh(), null, 'and does nothing after stop');
  ok('the hub follows the site when it changes, explicit choices always win, and stop() removes everything it attached');
}
{
  const f = fakeWin({ styles: { body: { 'background-color': 'rgb(0, 0, 0)' } } });
  const t = applyTheme(f.root, { win: f.win, observe: false });
  assert.equal(f.observed.length, 0); assert.equal(f.listeners.length, 0); t.stop();
  ok('watching can be turned off');
}
{
  // hints sample the site's own elements, never the hub's; a link that is just the body color is not an accent
  const f = fakeWin({ styles: { body: { 'background-color': 'rgb(12, 7, 18)', color: 'rgb(241, 232, 220)' }, gold: { color: 'rgb(201, 162, 74)' }, magenta: { 'background-color': 'rgb(138, 21, 56)', borderTopLeftRadius: '0px' }, ownbtn: { 'background-color': 'rgb(1, 2, 3)' } } });
  const mkEl = (name, inside) => { const e = { name, parentElement: inside ? f.root : f.root.parentElement }; return e; };
  const gold = mkEl('gold', false), magenta = mkEl('magenta', false), own = mkEl('ownbtn', true);
  f.win.document.querySelectorAll = (sel) => ({ '.gold': [own, gold], '.magenta': [magenta] }[sel] || []);
  f.win.document.querySelector = (sel) => f.win.document.querySelectorAll(sel)[0] || null;
  f.root.contains = (e) => e === own;
  const page = readPage(f.root, { hints: { accent: '.gold', primary: '.magenta' }, win: f.win });
  assert.equal(toHex(page.accent), '#c9a24a', 'the hub\'s own element is skipped, the site\'s is sampled');
  assert.equal(toHex(page.button), '#8a1538');
  const t = themeFrom(page); assert.equal(t.vars['--eh-accent'], '#c9a24a'); assert.equal(t.vars['--eh-primary'], '#8a1538');
  ok('hints sample the site\'s own elements only (never the hub\'s), so a site with gold accents and burgundy buttons is read correctly');
}
console.log(`\n${n} passed`);

/* the stylesheet is plain CSS: a stray escape sequence (a literal backslash-n) once broke the first rule of a block */
import { readFileSync as _rf } from 'node:fs';
{ const css = _rf(new URL('./ui/hub.css', import.meta.url), 'utf8'); assert.ok(!css.includes('\\n'), 'no stray backslash-n in hub.css'); console.log('  ok  hub.css has no stray escape sequences'); }
