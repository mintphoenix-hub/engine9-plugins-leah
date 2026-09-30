/*
  The email hub's screens, as one browser module.

    import { mountEmailHub } from '/email-hub/hub.js';
    const hub = mountEmailHub(document.getElementById('email'), {
      base: '/api/admin/mail',            // where the host serves createEmailHub().handle
      timeZone: 'Australia/Brisbane',     // the site's own zone: schedule times are read on its clock
      locale: 'en-AU', brandName: 'Example Studio',
      extras: { homeStats: async (days) => [{ label: 'Website visits', value: 214 }] }   // optional, host-supplied
    });

  Options (all optional; the defaults are the plain look):
    emoji: ['🌿', ...]        the host's emoji set for the composer            emojiOpen: true   the tray starts open
    fontChoice: true          show a "Words" Sans / Serif choice on Content (writes style.font; the host's shell must honour it)
    logoHelp: 'text'          a line under the logo choices on Content
    theme: true               take the look from the site the screens are in, and keep up when it changes (theme.js). An object
                              { vars, hints, observe } sets explicit --eh-* values (which always win), selectors to sample
                              ({ accent, primary, heading, panel }), or turns watching off. Returns theme.refresh() / theme.stop() as
                              hub.theme.
    extras.homeStats(days)    -> [{ label, value, note }]   extra numbers in the Home snapshot
    extras.homeCards()        -> [{ title, html }]           extra cards on Home, under Recent campaigns (host-trusted HTML)
    extras.homeBanner()       -> { html, label, run }        a line at the top of Home, with an optional button
    extras.analyticsBanner()  -> { html, label, run }        the same on Analytics
  From GET /config the screens also read `schedule: { leadMinutes, stepMinutes }` (default 15 and 15), `capabilities.templates`
  (lists GET /templates on Content) and GET /archive (read-only emails from a previous service, merged into Past campaigns).

  Left nav (Create, Home, Campaigns, Audience, Analytics, Content), laid out like the service's own. Every page reads
  from the service each time it opens; nothing is stored here except an unsent draft in this browser. The only thing
  that ever reaches an audience is the Schedule box on a draft, which asks for a tick. Theme it with the --eh-* variables
  in hub.css.

  It imports the same shell.js the server uses, so the "opened" preview is what is saved.
*/
import { bodyHtml } from '../shell.js';
import { cleanEmailHtml as cleanHtml } from '../pasted.js';
import { parseCsv } from '../csv.js';
import { wallToUtc } from '../time.js';
import { applyTheme } from './theme.js';

const ICON = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', campaigns: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  audience: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><path d="M16 5a3.5 3.5 0 0 1 0 6.5M18 14c2 .8 3.5 2.7 3.5 6"/>',
  analytics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', content: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  create: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  draft: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>', scheduled: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', sent: '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'
};
const svg = (d, s = 18) => `<svg width="${s}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const PAGES = [['home', 'Home'], ['campaigns', 'Campaigns'], ['audience', 'Audience'], ['analytics', 'Analytics'], ['content', 'Content']];
const LABEL = { save: 'Draft', paused: 'Draft', schedule: 'Scheduled', sending: 'Sending', sent: 'Sent' };
const STATE = { subscribed: 'Subscribed', unsubscribed: 'Unsubscribed', cleaned: 'Bounced', pending: 'Not confirmed yet' };
const EMOJI = ['🌿', '✨', '💛', '🌊', '🎶', '🕊️', '🌸', '☀️', '🌙', '💫', '🙏', '🧘', '🔔', '🗓️', '📣', '🎉'];
const COLORS = [['ground', 'Page background'], ['card', 'Card'], ['border', 'Card edge'], ['accent', 'Divider line'], ['text', 'Words'], ['muted', 'Footer words'], ['link', 'Links']];
const SUBJECT_SOFT = 60, PREVIEW_SOFT = 100;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chars = (t) => Array.from(String(t || ''));
const clip = (t, n) => chars(t).slice(0, n).join('');
const kindOf = (c) => (c.status === 'save' || c.status === 'paused' ? 'draft' : c.status === 'schedule' ? 'scheduled' : 'sent');

export function mountEmailHub(root, options = {}) {
  const { base = '/mail', timeZone = 'UTC', locale = 'en-US', brandName = '', extras = {}, draftKey = 'email-hub-draft', emoji = EMOJI, emojiOpen = false, fontChoice = false } = options;
  const doFetch = options.fetch || ((...a) => globalThis.fetch(...a));
  const st = { page: 'home', sub: '', days: 30, ov: null, all: [], dc: null, label: 'your email service', caps: {}, filter: 'all', open: null, mode: null, sort: 'new', q: '', audience: null, look: null, lookDraft: null, pv: 'inbox', last: 'eh-sub', reportId: null,
    ppl: { status: 'subscribed', tag: '', email: '', after: '', stack: [], open: null, counts: null }, csv: null, appUrl: '', archive: [], sched: { leadMinutes: 15, stepMinutes: 15 }, homeBanner: null };

  /* ---- plumbing ---- */
  async function api(path, opts = {}) {
    const res = await doFetch(base + path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    return body;
  }
  const $ = (s) => root.querySelector(s);
  const main = () => $('.eh-main');
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString(locale));
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);
  const day = (iso) => new Date(iso).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone });
  const time = (iso) => new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone }).replace(/ /g, ' ');
  const when = (iso) => (iso ? `${day(iso)}, ${time(iso)}` : '');
  const short = (iso) => (iso ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone }) : '');
  const say = (el, text, bad = false) => { if (!el) return; el.textContent = text; el.classList.toggle('eh-bad', bad); };
  const flash = (text) => { const f = $('.eh-flash'); if (!f) return; f.textContent = text; f.classList.toggle('eh-hide', !text); if (text) setTimeout(() => { if (f.textContent === text) f.classList.add('eh-hide'); }, 8000); };
  const appLink = (p, label) => `<a class="eh-btn eh-o eh-s" href="${esc((st.appUrl || '').replace(/\/$/, '') + p)}" target="_blank" rel="noopener">${esc(label || `Open in ${st.label}`)}</a>`;
  const head = (title, lead, actions = '') => `<div class="eh-head"><div><h2>${esc(title)}</h2>${lead ? `<p>${esc(lead)}</p>` : ''}</div><div class="eh-row">${actions}</div></div><p class="eh-flash eh-hide" role="status"></p>`;
  const off = () => `<div class="eh-card"><h3>${esc(st.label)} is not connected yet</h3><p class="eh-small eh-muted">Ask whoever looks after this site to finish connecting it. Nothing here works until then.</p></div>`;
  const fail = (e) => `<p class="eh-msg eh-bad">${esc(e.message || e)}</p>`;
  const tag = (c) => `<span class="eh-tag ${kindOf(c)}">${esc(LABEL[c.status] || c.status)}</span>`;
  /* Shown when a period's email figures come from the emails kept from a previous provider, not from this service. */
  const keptNote = (d) => (d && d.fromArchive ? `<p class="eh-small eh-muted" style="margin:.7rem 0 0">Email figures are from emails kept from ${esc(String(d.fromArchive).replace(/^./, (x) => x.toUpperCase()))}, until ${esc(st.label)} has sent some.</p>` : '');
  const stat = (label, value, note) => `<div class="eh-stat"><b>${esc(value)}</b><span>${esc(label)}</span>${note ? `<i>${esc(note)}</i>` : ''}</div>`;
  const bars = (rows, max) => rows.map(([l, n, t]) => `<div class="eh-bar2"><span>${esc(l)}</span><span class="eh-trk" aria-hidden="true"><i style="width:${max ? Math.round(100 * (n || 0) / max) : 0}%"></i></span><span class="eh-n">${esc(t ?? num(n))}</span></div>`).join('');
  const fit = (f) => { try { const d = f.contentDocument; if (d?.documentElement) f.style.height = d.documentElement.scrollHeight + 'px'; } catch { /* keep the default height */ } };
  const everyEmail = () => st.all.concat(st.archive);
  const findEmail = (id) => everyEmail().find((x) => x.id === id);

  /* ---- shell ---- */
  root.classList.add('eh');
  /* theme: true (or an options object) makes the screens take their look from the site they are in, and keep up when the site
     changes (see theme.js). Anything the host sets on the element itself still wins, key by key, through theme.vars. */
  const theme = options.theme ? applyTheme(root, options.theme === true ? {} : options.theme) : null;
  root.innerHTML = `<div class="eh-hub"><nav class="eh-nav" aria-label="Email sections"><button type="button" class="eh-btn eh-alt eh-create" data-act="create">${svg(ICON.create, 16)} Create</button><ul id="eh-navlist"></ul></nav><div class="eh-main" aria-live="polite"><p class="eh-muted">Loading…</p></div></div>`;

  /* The left nav. Audience carries its own choices (All contacts, Tags, ...) underneath while you are in it. */
  const audienceTabs = () => [['contacts', 'All contacts'], st.caps.tags && ['tags', 'Tags'], st.caps.segments && ['segments', 'Segments'], st.caps.fields && ['fields', 'Fields'], st.caps.import && ['import', 'Import contacts']].filter(Boolean);
  function renderNav() {
    const cur = (k) => k === st.page && !(k === 'campaigns' && (st.sub === 'new' || st.sub === 'report'));
    const subs = st.page === 'audience' && st.caps.contacts ? `<ul class="eh-sub" aria-label="Audience">${audienceTabs().map(([k, l]) => `<li><button type="button" data-act="asub" data-sub="${k}" aria-current="${(st.sub || 'contacts') === k}">${l}</button></li>`).join('')}</ul>` : '';
    $('#eh-navlist').innerHTML = PAGES.map(([k, l]) => `<li><button type="button" data-act="nav" data-page="${k}" aria-current="${cur(k)}">${svg(ICON[k])}<span>${l}</span></button>${k === 'audience' ? subs : ''}</li>`).join('');
  }
  function go(page, sub = '') {
    st.page = page; st.sub = sub; if (page !== 'campaigns') { st.open = null; st.mode = null; }
    renderNav();
    return render();
  }
  async function render() {
    main().innerHTML = '<p class="eh-muted">Loading…</p>';
    try {
      if (!st.appUrl) { const c = await api('/config').catch(() => null); if (c) { st.label = c.label; st.caps = c.capabilities; st.appUrl = c.appUrl || ''; st.mergeTags = c.mergeTags || {}; if (c.schedule) st.sched = { leadMinutes: Number(c.schedule.leadMinutes) || 15, stepMinutes: Number(c.schedule.stepMinutes) || 15 }; renderNav(); } }
      if (st.page === 'home') await home();
      else if (st.page === 'campaigns') await (st.sub === 'new' ? compose() : st.sub === 'report' ? report() : campaigns());
      else if (st.page === 'audience') await audience();
      else if (st.page === 'analytics') await analytics();
      else if (st.page === 'content') await content();
    } catch (err) { main().innerHTML = fail(err); }
  }
  async function overview(force) {
    if (!st.ov || force) { const d = await api('/overview'); if (d.connected === false) { st.label = d.label || st.label; main().innerHTML = off(); return null; } st.ov = d; st.all = d.campaigns; st.dc = d.dc; st.audience = d.audience || st.audience; }
    return st.ov;
  }

  /* ---- shared drawing ---- */
  function recentTable(rows) {
    if (!rows.length) return '';
    return `<table class="eh-table"><thead><tr><th>Email</th><th>Status</th><th class="num">Sent to</th><th class="num">Opened</th><th class="num">Clicked</th></tr></thead><tbody>${rows.map((c) => {
      const k = kindOf(c);
      return `<tr><td><button type="button" class="eh-link" data-act="goto" data-id="${esc(c.id)}">${esc(c.subject || c.title || '(no subject yet)')}</button><small>${esc(k === 'scheduled' ? `Goes out ${when(c.when)}` : k === 'sent' ? `Sent ${when(c.when)}` : `Started ${short(c.created)}`)}</small></td><td>${tag(c)}</td><td class="num eh-hide-s">${num(k === 'sent' ? (c.sent ?? c.recipients) : c.recipients)}</td><td class="num eh-hide-s">${pct(c.openRate)}</td><td class="num eh-hide-s">${pct(c.clickRate)}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  /* ---- Home ---- */
  async function home() {
    const d = await overview(); if (!d) return;
    const g = st.days === 30 ? d.growth30 : d.growth90, e = st.days === 30 ? d.email30 : d.email90, c = d.counts, camps = d.campaigns.slice(0, 5);
    const more = extras.homeStats ? await extras.homeStats(st.days).catch(() => []) : [];
    const cards = extras.homeCards ? await extras.homeCards().catch(() => []) : [];
    st.homeBanner = extras.homeBanner ? await extras.homeBanner().catch(() => null) : null;
    const subs = c.ok ? c.data.subscribed : d.audience?.subscribers;
    main().innerHTML = head('Home', 'How your list is doing, and what went out last.', `<select id="eh-days" aria-label="Period" style="width:auto"><option value="30"${st.days === 30 ? ' selected' : ''}>Last 30 days</option><option value="90"${st.days === 90 ? ' selected' : ''}>Last 90 days</option></select>`) +
      (st.homeBanner ? `<div class="eh-card" style="margin-bottom:1.4rem;display:flex;flex-wrap:wrap;gap:.6rem 1.2rem;align-items:center;justify-content:space-between"><span>${st.homeBanner.html}</span>${st.homeBanner.label ? `<button type="button" class="eh-btn eh-o eh-s" data-act="home-banner">${esc(st.homeBanner.label)}</button>` : ''}</div>` : '') + `<div class="eh-grid"><div class="eh-card eh-tint"><h3>Marketing snapshot <small>The last ${st.days} days</small></h3><div class="eh-stats">${stat('Total sends', num(e.data.sent))}${stat('Open rate', pct(e.data.openRate))}${stat('Click rate', pct(e.data.clickRate))}${more.map((m) => stat(m.label, num(m.value), m.note)).join('')}${g.ok ? stat('New contacts', num(g.data.added)) + stat('Unsubscribed', num(g.data.unsubscribed)) + stat('Net growth', g.data.net > 0 ? `+${g.data.net}` : String(g.data.net)) : `<p class="eh-msg eh-bad">${esc(g.error)}</p>`}</div>${keptNote(e.data)}</div>
      <div class="eh-card"><h3>Recent campaigns <button type="button" class="eh-link eh-small" data-act="nav" data-page="campaigns">All campaigns &rarr;</button></h3>${camps.length ? recentTable(camps) : '<p class="eh-small eh-muted">Nothing yet. Use Create to write your first email.</p>'}</div>
      ${cards.map((c) => `<div class="eh-card"><h3>${esc(c.title)}</h3>${c.html}</div>`).join('')}
      <div class="eh-card"><h3>Audience <button type="button" class="eh-link eh-small" data-act="nav" data-page="audience">Audience &rarr;</button></h3>${stat('Total contacts', num(subs), 'Subscribed, can be emailed')}
        ${c.ok ? `<div style="margin-top:.9rem;font-size:calc(.9rem*var(--eh-scale,1))">${[['Unsubscribed', c.data.unsubscribed], ['Bounced', c.data.cleaned], ['Not confirmed yet', c.data.pending]].map(([l, n]) => `<div style="display:flex;justify-content:space-between;padding:.25rem 0;border-top:1px solid var(--eh-rule)"><span class="eh-muted">${l}</span><span>${num(n)}</span></div>`).join('')}</div>` : ''}</div></div>`;
  }

  /* ---- Campaigns ---- */
  async function campaigns() {
    const [d] = await Promise.all([api('/campaigns'), loadLayouts(), loadTemplates()]);
    if (d.connected === false) { st.label = d.label || st.label; main().innerHTML = off(); return; }
    st.all = d.campaigns; st.dc = d.dc || st.dc;
    // Emails carried over from a service that is gone or replaced: read-only, and nothing is shown when there are none.
    const a = await api('/archive').catch(() => ({ archive: [] }));
    const frac = (v) => (v == null ? null : Number(v) > 1 ? Number(v) / 100 : Number(v));
    st.archive = (a.archive || []).map((r) => ({ id: `arch:${r.source}:${r.id}`, archive: true, source: r.source, sourceId: r.id, status: 'sent', subject: r.subject || r.title || '', title: r.title || '', preview: r.previewText || '', audience: r.audience || '', segment: r.segmentText || '',
      recipients: r.emailsSent ?? null, sent: r.emailsSent ?? null, created: r.sentAt || null, when: r.sentAt || null, openRate: frac(r.openRate), clickRate: frac(r.clickRate), stats: { opened: r.uniqueOpens ?? null, clicked: r.clicks ?? null }, archiveUrl: r.archiveUrl || null, editUrl: null }));
    draw(true);
  }
  function draw(full) {
    const all = everyEmail(), drafts = all.filter((c) => kindOf(c) === 'draft'), sched = all.filter((c) => kindOf(c) === 'scheduled'), sent = all.filter((c) => kindOf(c) === 'sent');
    const next = sched.slice().sort((a, b) => String(a.when).localeCompare(b.when))[0], rates = sent.map((c) => c.openRate).filter((r) => r != null);
    const tiles = [['all', 'All emails', all.length, st.archive.length ? `${st.label} and the archive` : `In ${st.label}`], ['draft', 'Drafts', drafts.length, drafts.length ? 'Not sent, not scheduled' : 'None waiting'], ['scheduled', 'Scheduled', sched.length, next ? `Next: ${short(next.when)}` : 'Nothing queued'], ['sent', 'Past campaigns', sent.length, rates.length ? `Avg ${pct(rates.reduce((a, b) => a + b, 0) / rates.length)} opened` : 'Nothing sent yet']];
    const q = st.q.trim().toLowerCase(), t = (c) => Date.parse(c.when || c.created || 0) || 0;
    let rows = all.filter((c) => (st.filter === 'all' || kindOf(c) === st.filter) && (!q || `${c.subject} ${c.title} ${c.preview}`.toLowerCase().includes(q)));
    rows = rows.slice().sort(st.sort === 'az' ? (a, b) => (a.subject || a.title).localeCompare(b.subject || b.title) : st.sort === 'old' ? (a, b) => t(a) - t(b) : (a, b) => t(b) - t(a));
    const empty = { all: 'Nothing has been made yet.', draft: 'No drafts waiting.', scheduled: 'Nothing is scheduled to go out.', sent: 'Nothing has been sent yet.' }[st.filter];
    const list = rows.length ? `<ul class="eh-rows" aria-label="Emails">${rows.map(row).join('')}</ul>` : `<div class="eh-empty"><p class="eh-muted">${q ? 'Nothing matches that.' : empty}</p>${!q && (st.filter === 'all' || st.filter === 'draft') ? '<button class="eh-btn eh-s" type="button" data-act="create" style="margin-top:1rem">Create email</button>' : ''}</div>`;
    const count = `<p class="eh-small eh-muted">${rows.length === all.length ? `${rows.length} ${rows.length === 1 ? 'email' : 'emails'}` : `${rows.length} of ${all.length}`}</p>`;
    if (!full) { $('#eh-count').innerHTML = count; $('#eh-rows').innerHTML = list; root.querySelectorAll('.eh-tile').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.f === st.filter))); if (st.open) loadPreview(st.open); return; }
    main().innerHTML = head('Campaigns', `Every email in ${st.label}: what is waiting, what is queued, and how the sent ones did.`, `<button class="eh-btn" type="button" data-act="create">Create email</button>${appLink('/campaigns/')}`) +
      `<div class="eh-tiles" role="tablist" aria-label="Emails">${tiles.map(([f, l, n, note]) => `<button type="button" role="tab" class="eh-tile" data-act="filter" data-f="${f}" aria-selected="${st.filter === f}"><span>${l}</span><b>${n}</b><small>${esc(note)}</small></button>`).join('')}</div>
      <div class="eh-bar"><div id="eh-count">${count}</div><div class="eh-row"><input id="eh-q" type="search" placeholder="Search subject or name" aria-label="Search emails" autocomplete="off" value="${esc(st.q)}"><select id="eh-sort" aria-label="Sort"><option value="new"${st.sort === 'new' ? ' selected' : ''}>Newest first</option><option value="old"${st.sort === 'old' ? ' selected' : ''}>Oldest first</option><option value="az"${st.sort === 'az' ? ' selected' : ''}>Subject A to Z</option></select><button class="eh-btn eh-o eh-s" type="button" data-act="refresh-list">Refresh</button></div></div><div id="eh-rows">${list}</div>`;
    if (st.open) loadPreview(st.open);
  }
  function row(c) {
    const k = kindOf(c), open = st.open === c.id, id = esc(c.id), name = c.subject || c.title || '(no subject yet)';
    const dateLine = k === 'scheduled' ? `Goes out ${when(c.when)}` : k === 'sent' ? `Sent ${when(c.when)}` : `Started ${short(c.created)}`;
    const strip = k === 'sent' ? `<dl class="eh-strip"><div><dt>Sent to</dt><dd>${num(c.sent ?? c.recipients)}</dd></div><div style="width:11rem"><dt>Opened</dt><dd>${pct(c.openRate)}${c.stats?.opened != null ? ` <small>${num(c.stats.opened)} people</small>` : ''}</dd><span class="eh-trk" aria-hidden="true"><i style="width:${Math.min(100, Math.round((c.openRate || 0) * 100))}%"></i></span></div><div><dt>Clicked</dt><dd>${pct(c.clickRate)}${c.stats?.clicked != null ? ` <small>${num(c.stats.clicked)} people</small>` : ''}</dd></div></dl>`
      : c.recipients != null ? `<p class="eh-small eh-muted" style="margin-top:.9rem">Would reach about <strong style="font-weight:500;color:var(--eh-ink)">${num(c.recipients)}</strong> people today</p>` : '';
    const items = c.archive ? [['m-preview', 'Preview']] : [['m-preview', 'Preview'], k === 'draft' && ['m-schedule', 'Schedule…'], k === 'scheduled' && ['unsched', 'Unschedule'], k === 'draft' && ['m-edit', 'Edit details…'], st.caps.test && ['m-test', 'Send a test…'], ['dup', 'Duplicate'], k === 'draft' && ['m-delete', 'Delete draft', 1], k === 'sent' && st.caps.report && ['report', 'View report']].filter(Boolean);
    return `<li class="eh-rowx k-${k}${open ? ' eh-open' : ''}"><div class="eh-rowx-top"><div class="eh-rowx-main"><span class="eh-sicon ${k}" aria-hidden="true">${svg(ICON[k])}</span><div class="eh-rowx-body">
      <button type="button" class="eh-subj" data-act="${k === 'sent' && (c.archive || st.caps.report) ? 'report' : 'review'}" data-id="${id}">${esc(name)}</button>
      <p class="eh-facts">${tag(c)}${c.archive ? `<span class="eh-src" title="Kept from ${esc(c.source)}, read-only">${esc(c.source)}</span>` : ''}<span>${esc(dateLine)}</span>${c.title && c.title !== c.subject ? `<span>${esc(c.title)}</span>` : ''}${c.archive ? '' : `<span>${c.segment ? 'To one group' : 'To everyone'}</span>`}</p>
      ${c.preview ? `<p class="eh-prev" title="${esc(c.preview)}">${esc(c.preview)}</p>` : ''}${strip}</div></div>
      <div class="eh-rowx-side">${k === 'sent' && (c.archive || st.caps.report) ? `<button type="button" class="eh-btn eh-o eh-s" data-act="report" data-id="${id}">View report</button>` : `<button type="button" class="eh-btn eh-o eh-s" data-act="review" data-id="${id}" aria-expanded="${open}">${open ? 'Close' : 'Review'}</button>`}
      <div class="eh-menu"><button type="button" class="eh-more" data-act="menu" data-id="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(name)}">&#8943;</button><ul class="eh-menu-list eh-hide" role="menu">${items.map(([a, l, dg]) => `<li role="none"><button type="button" role="menuitem" data-act="${a}" data-id="${id}"${dg ? ' class="eh-dangerous"' : ''}>${l}</button></li>`).join('')}${c.editUrl ? `<li role="none"><a role="menuitem" href="${esc(c.editUrl)}" target="_blank" rel="noopener">Open in ${esc(st.label)} &#8599;</a></li>` : ''}</ul></div></div></div>
      ${open ? `<div class="eh-panel">${panel(c, k)}</div>` : ''}</li>`;
  }
  function panel(c, k) {
    const id = esc(c.id);
    const box = st.mode === 'edit' && k === 'draft' ? `<div class="eh-box"><div class="eh-field"><label for="ed-sub">Subject line</label><input id="ed-sub" type="text" maxlength="150" value="${esc(c.subject)}"></div><div class="eh-field"><label for="ed-pre">Preview text</label><input id="ed-pre" type="text" maxlength="150" value="${esc(c.preview)}"></div><div class="eh-field"><label for="ed-title">Name for your own reference</label><input id="ed-title" type="text" maxlength="100" value="${esc(c.title)}"></div><div class="eh-row"><button class="eh-btn eh-s" type="button" data-act="edit-save" data-id="${id}">Save changes</button><button class="eh-btn eh-o eh-s" type="button" data-act="mode-x">Cancel</button></div></div>`
      : st.mode === 'template' && k === 'draft' && st.caps.templateChange && st.tpls?.length > 1 ? templateBox(c)
      : st.mode === 'schedule' && k === 'draft' ? scheduleBox(c)
      : st.mode === 'test' && st.caps.test ? `<div class="eh-box"><div class="eh-field"><label for="ts-to">Send a test to (up to three addresses, separated by commas)</label><input id="ts-to" type="text" autocomplete="off"></div><div class="eh-row"><button class="eh-btn eh-s" type="button" data-act="test-send" data-id="${id}">Send test</button><button class="eh-btn eh-o eh-s" type="button" data-act="mode-x">Cancel</button></div><p class="eh-small eh-muted" style="margin:.5rem 0 0">A test goes only to these addresses, never to your list.</p></div>`
      : st.mode === 'delete' && k === 'draft' ? `<div class="eh-box"><p style="margin:0 0 .7rem">Delete the draft &ldquo;${esc(c.subject || c.title || 'untitled')}&rdquo;? This cannot be undone.</p><div class="eh-row"><button class="eh-btn eh-danger eh-s" type="button" data-act="del" data-id="${id}">Delete draft</button><button class="eh-btn eh-o eh-s" type="button" data-act="mode-x">Cancel</button></div></div>` : '';
    const acts = [];
    if (k === 'draft') acts.push(`<button class="eh-btn eh-s" type="button" data-act="m-schedule" data-id="${id}">Schedule</button>`, `<button class="eh-btn eh-o eh-s" type="button" data-act="m-edit" data-id="${id}">Edit details</button>`);
    if (k === 'draft' && st.caps.templateChange && st.tpls?.length > 1) acts.push(`<button class="eh-btn eh-o eh-s" type="button" data-act="m-template" data-id="${id}">Change design</button>`);
    if (k === 'scheduled') acts.push(`<button class="eh-btn eh-o eh-s" type="button" data-act="unsched" data-id="${id}">Unschedule</button>`);
    if (st.caps.test) acts.push(`<button class="eh-btn eh-o eh-s" type="button" data-act="m-test" data-id="${id}">Send a test</button>`);
    acts.push(`<button class="eh-btn eh-o eh-s" type="button" data-act="dup" data-id="${id}">Duplicate</button>`);
    if (k === 'draft' && st.layouts?.enabled) acts.unshift(`<button class="eh-btn eh-o eh-s eh-hide" type="button" data-act="edit-fields" data-id="${id}" data-fields="1">Edit the fields</button>`);
    if (k === 'draft') acts.push(`<button class="eh-btn eh-danger eh-s" type="button" data-act="m-delete" data-id="${id}">Delete draft</button>`);
    if (c.editUrl) acts.push(`<a class="eh-btn eh-o eh-s" href="${esc(c.editUrl)}" target="_blank" rel="noopener">${k === 'draft' ? 'Preview the full design in' : 'Edit the design in'} ${esc(st.label)} &#8599;</a>`);
    if (c.archive) return `<div class="eh-panel-grid"><div class="eh-frame-box"><div class="eh-frame-head"><small>KEPT FROM ${esc(String(c.source).toUpperCase())}, READ-ONLY</small><b>${esc(c.subject || '(no subject)')}</b>${c.preview ? `<span>${esc(c.preview)}</span>` : ''}</div><iframe class="eh-frame" sandbox="allow-same-origin" title="Preview of ${esc(c.subject)}" data-frame="${id}"></iframe></div>
      <aside class="eh-aside"><dl class="eh-dl"><dt>Status</dt><dd>${tag(c)}</dd><dt>Source</dt><dd>${esc(c.source)}</dd><dt>Sent</dt><dd>${esc(when(c.when))}</dd><dt>To</dt><dd>${esc(c.audience || 'The list')}${c.recipients != null ? ` <span class="eh-muted">(${num(c.recipients)} people)</span>` : ''}</dd><dt>Opened</dt><dd>${pct(c.openRate)}</dd><dt>Clicked</dt><dd>${pct(c.clickRate)}</dd></dl>${c.archiveUrl ? `<a class="eh-btn eh-o eh-s" href="${esc(c.archiveUrl)}" target="_blank" rel="noopener">Open the web copy &#8599;</a>` : ''}</aside></div>`;
    return `<div class="eh-panel-grid"><div class="eh-frame-box"><div class="eh-frame-head"><small>FROM ${esc((brandName || 'you').toUpperCase())}</small><b>${esc(c.subject || '(no subject yet)')}</b>${c.preview ? `<span>${esc(c.preview)}</span>` : ''}</div><iframe class="eh-frame" sandbox="allow-same-origin" title="Preview of ${esc(c.subject)}" data-frame="${id}"></iframe></div>
      <aside class="eh-aside"><dl class="eh-dl"><dt>Status</dt><dd>${tag(c)}</dd><dt>To</dt><dd>${esc(c.segment ? 'One group' : 'Everyone on the list')}${c.recipients != null ? ` <span class="eh-muted">(${num(c.recipients)} people)</span>` : ''}</dd><dt>${k === 'scheduled' ? 'Goes out' : k === 'sent' ? 'Sent' : 'Started'}</dt><dd>${esc(k === 'draft' ? short(c.created) : when(c.when))}</dd>${c.title && c.title !== c.subject ? `<dt>Name</dt><dd>${esc(c.title)}</dd>` : ''}</dl>
      ${k === 'draft' && st.caps.checklist ? '<div id="eh-ready" class="eh-small eh-muted">Checking with ' + esc(st.label) + '…</div>' : ''}<div class="eh-acts">${acts.join('')}</div><p class="eh-msg" id="eh-rowmsg" role="status" aria-live="polite"></p>${box}</aside></div>`;
  }
  /* "on the quarter hour" for 15, "to the minute" for 1, otherwise "rounded up to the next N minutes". */
  const stepWords = () => (st.sched.stepMinutes === 15 ? 'go out on the quarter hour' : st.sched.stepMinutes === 1 ? 'go out at the minute you choose' : `are rounded up to the next ${st.sched.stepMinutes} minutes`);
  function scheduleBox(c) {
    return `<div class="eh-box"><strong>Schedule it</strong><p class="eh-small eh-muted" style="margin:.2rem 0 .6rem">This sends to ${num(c.recipients)} people. Times are ${esc(timeZone.replace(/_/g, ' '))} time and ${stepWords()}, at least ${st.sched.leadMinutes} minutes from now.</p>
      <div class="eh-field"><input type="datetime-local" id="eh-when" step="${st.sched.stepMinutes * 60}" style="max-width:15rem" aria-label="Day and time to send"></div><p class="eh-small" id="eh-when-note" style="margin:0 0 .6rem"></p>
      <label class="eh-check" style="margin-bottom:.8rem"><input type="checkbox" id="eh-ok"><span>I have read the preview and it is right. Send it to this list at that time.</span></label>
      <div class="eh-row"><button class="eh-btn" type="button" data-act="sched" data-id="${esc(c.id)}" id="eh-sched" disabled>Schedule it</button><button class="eh-btn eh-o eh-s" type="button" data-act="mode-x">Cancel</button></div></div>`;
  }
  /* The preview frame lives inside the host's page, so it obeys the host's security rules (Content-Security-Policy). A host that
     allows only its own images shows none of an email's pictures, which sit on the mailing service's servers. When pictures in
     the frame fail, say why and how to fix it, once. (The frame is same-origin, so its images can be read.) */
  function picturesNote(f) {
    try {
      const box = f.closest('.eh-frame-box'); if (!box || box.querySelector('.eh-pics')) return;
      const broken = [...f.contentDocument.images].filter((i) => /^https?:/i.test(i.getAttribute('src') || '') && i.complete && i.naturalWidth === 0);
      if (!broken.length) return;
      box.insertAdjacentHTML('beforeend', `<p class="eh-pics eh-small eh-muted" style="padding:.6rem .8rem;margin:0">${broken.length === 1 ? 'A picture' : broken.length + ' pictures'} in this email did not load in the preview. If this page limits which pictures it may show, allow secure image addresses for this page (<code>img-src 'self' data: https:</code>). The email itself is not affected, and a test email shows it as people will see it.</p>`);
    } catch { /* a frame we cannot read has nothing to report */ }
  }
  async function loadPreview(id) {
    const f = root.querySelector(`[data-frame="${id}"]`); if (!f) return;
    f.addEventListener('load', () => { fit(f); picturesNote(f); });
    const own = findEmail(id);
    try { const d = await api(own?.archive ? `/archive/${own.source}/${own.sourceId}/content` : `/campaigns/${id}/content`); if (d.templateId) (st.tplOf = st.tplOf || {})[id] = d.templateId; f.srcdoc = d.designed || d.html || '<p style="font-family:sans-serif;padding:1rem">No content yet.</p>'; const bare = !own?.archive && !d.designed && d.html && !/background|bgcolor/i.test(d.html); const box = f.closest('.eh-frame-box'); if (box && !box.querySelector('.eh-bare')) box.insertAdjacentHTML('beforeend', bare ? `<p class="eh-bare eh-small eh-muted" style="padding:.6rem .8rem;margin:0">This is the message text only. The full designed email can be previewed on ${esc(st.label)} or via test email.</p>` : ''); }
    catch (err) { f.srcdoc = `<p style="font-family:sans-serif;padding:1rem">${esc(err.message)}</p>`; }
    const own2 = findEmail(id);
    if (own2 && kindOf(own2) === 'draft' && st.layouts?.enabled) {         // a draft made from a layout can be changed by editing its fields
      try { const l = await api(`/campaigns/${id}/layout`); if (l.layout) root.querySelectorAll(`[data-act="edit-fields"][data-id="${id}"]`).forEach((b) => b.classList.remove('eh-hide')); } catch { /* no fields to edit */ }
    }
    const c = findEmail(id); if (!c || kindOf(c) !== 'draft' || !st.caps.checklist) return;
    try { const r = await api(`/campaigns/${id}/checklist`); const el = $('#eh-ready'); if (!el) return;
      el.innerHTML = r.ready ? `<span>&#10003;</span> ${esc(st.label)} says this is ready to send.` : '<span>&#33;</span> Not ready yet:<ul style="margin:.3rem 0 0;padding-left:1.2rem;list-style:disc">' + r.problems.map((p) => `<li>${esc(p.heading || p.details)}</li>`).join('') + '</ul>';
    } catch (err) { const el = $('#eh-ready'); if (el) el.textContent = err.message; }
  }
  /* The time she picked is read on the site's own clock, then rounded up to the quarter hour the way the server does. */
  const whenAt = (v) => { const ms = wallToUtc(v, timeZone), step = st.sched.stepMinutes * 60000; return Number.isFinite(ms) ? Math.ceil(ms / step) * step : NaN; };

  async function act(action, btn) {
    const id = btn.dataset.id || st.open, c = findEmail(id); if (!c || (c.archive && action !== 'm-preview')) return;
    const open = (mode) => { st.open = id; st.mode = mode; draw(false); root.querySelector('.eh-rowx.eh-open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    if (action === 'm-preview') return open(null);
    if (action === 'm-schedule') return open('schedule');
    if (action === 'm-edit') return open('edit');
    if (action === 'm-template') return open('template');
    if (action === 'm-test') return open('test');
    if (action === 'm-delete') return open('delete');
    const msg = () => $('#eh-rowmsg');
    const busy = async (fn) => { btn.disabled = true; try { await fn(); } catch (err) { if (msg()) say(msg(), err.message, true); else flash(err.message); } btn.disabled = false; };
    const back = (text, filter) => { if (filter) st.filter = filter; st.mode = null; draw(true); flash(text); };
    if (action === 'edit-save') busy(async () => { const d = await api(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ subject: $('#ed-sub').value, previewText: $('#ed-pre').value, title: $('#ed-title').value }) }); Object.assign(c, d.campaign); back('Details saved.'); });
    else if (action === 'test-send') busy(async () => { const d = await api(`/campaigns/${id}/test`, { method: 'POST', body: JSON.stringify({ emails: $('#ts-to').value.split(/[\s,;]+/).filter(Boolean) }) }); say(msg(), `Test sent to ${d.sentTo.join(', ')}.`); });
    else if (action === 'dup') busy(async () => { const d = await api(`/campaigns/${id}/duplicate`, { method: 'POST' }); const l = await api('/campaigns'); st.all = l.campaigns; st.open = d.campaign.id; const made = (await loadLayouts()).enabled ? await api(`/campaigns/${d.campaign.id}/layout`).catch(() => null) : null; if (made?.layout) { st.filter = 'draft'; st.page = 'campaigns'; st.sub = 'new'; return editFields(d.campaign.id, true); } back('Copied. The copy is a draft; nothing has been sent.', 'draft'); });
    else if (action === 'tpl-save') busy(async () => { const v = $('#tp-sel').value; await api(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ templateId: v }) }); (st.tplOf = st.tplOf || {})[id] = v; back('Design changed.'); });
    else if (action === 'del') busy(async () => { await api(`/campaigns/${id}`, { method: 'DELETE' }); st.all = st.all.filter((x) => x.id !== id); st.open = null; back('Draft deleted.'); });
    else if (action === 'unsched') busy(async () => { const d = await api(`/campaigns/${id}/unschedule`, { method: 'POST' }); Object.assign(c, d.campaign); st.open = id; back('Unscheduled. It is a draft again and will not be sent.', 'draft'); });
    else if (action === 'sched') busy(async () => { const at = whenAt($('#eh-when').value); const d = await api(`/campaigns/${id}/schedule`, { method: 'POST', body: JSON.stringify({ sendAt: new Date(at).toISOString(), confirm: $('#eh-ok').checked }) }); Object.assign(c, d.campaign); st.open = null; back(`Scheduled. It will go out ${when(d.scheduledFor)}. You can unschedule it until then.`, 'scheduled'); });
  }

  /* ---- one sent email's report ---- */
  async function report() {
    if (!st.all.length) { const d = await api('/campaigns'); st.all = d.campaigns || []; st.dc = d.dc || st.dc; }
    const c = findEmail(st.reportId);
    main().innerHTML = head(c ? (c.subject || c.title || 'Email') : 'Email report', c ? (kindOf(c) === 'sent' ? `Sent ${when(c.when)}` : kindOf(c) === 'scheduled' ? `Goes out ${when(c.when)}` : `Draft started ${short(c.created)}`) : '', `<button class="eh-btn eh-o eh-s" type="button" data-act="nav" data-page="campaigns">&larr; All campaigns</button>${c?.editUrl ? `<a class="eh-btn eh-o eh-s" href="${esc(c.editUrl)}" target="_blank" rel="noopener">Open in ${esc(st.label)}</a>` : ''}`) +
      (c ? `<div class="eh-grid"><div class="eh-card"><h3>Report</h3><div id="eh-rep" class="eh-stats"><span class="eh-muted">Loading…</span></div></div><div class="eh-card"><h3>The email</h3><div class="eh-frame-box"><iframe class="eh-frame" sandbox="allow-same-origin" title="The email" data-frame="${esc(c.id)}"></iframe></div></div></div>` : '<p class="eh-muted">That email is not in your account any more.</p>');
    if (!c) return;
    loadPreview(c.id);
    if (c.archive) { /* kept from a previous provider: the headline figures are all that came with it */
      $('#eh-rep').innerHTML = stat('Sent to', num(c.sent)) + stat('Opened', pct(c.openRate), c.stats?.opened != null ? `${num(c.stats.opened)} people` : '') + stat('Clicked', num(c.stats?.clicked), c.clickRate != null ? `${pct(c.clickRate)} click rate` : '')
        + `<p class="eh-small eh-muted" style="grid-column:1/-1;margin:.6rem 0 0">Kept from ${esc(String(c.source).replace(/^./, (x) => x.toUpperCase()))}, read-only. Only these headline figures were carried over, so there is no breakdown by link, no unsubscribe or bounce counts and no open timeline for this email.${c.audience ? ` Sent to: ${esc(c.audience)}${c.segment ? `, ${esc(c.segment)}` : ''}.` : ''}</p>`;
      return;
    }
    if (kindOf(c) !== 'sent') { $('#eh-rep').innerHTML = '<span class="eh-muted">Figures appear once the email has gone out.</span>'; return; }
    try { const r = await api(`/campaigns/${c.id}/report`); $('#eh-rep').innerHTML = stat('Recipients', num(r.recipients)) + stat('Opened', pct(r.openRate), r.opened != null ? `${num(r.opened)} people` : '') + stat('Clicked', num(r.clicked), r.clickRate != null ? `${pct(r.clickRate)} click rate` : '') + stat('Unsubscribed', num(r.unsubscribed)) + stat('Bounced', num(r.bounced)); }
    catch { $('#eh-rep').innerHTML = stat('Recipients', num(c.sent)) + stat('Opened', pct(c.openRate)) + stat('Clicked', pct(c.clickRate)); }
  }

  /* ---- Create email ---- */
  const step = (n, title, hint, inner) => `<section class="eh-step"><div class="eh-step-h"><span class="eh-stepn" aria-hidden="true">${n}</span><div><h3>${title}</h3>${hint ? `<p>${hint}</p>` : ''}</div></div>${inner}</section>`;
  async function compose() {
    await Promise.all([loadLayouts(), loadTemplates()]);
    let kept = null; try { kept = JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch { /* no storage */ }
    const restored = Boolean(kept && (kept.s || kept.x || kept.h)); st.last = 'eh-sub'; st.bodyMode = kept?.mode === 'html' ? 'html' : 'text';
    main().innerHTML = head('Create email', `Write it here, see it as an inbox will, and save it as a draft in ${st.label}. Nothing goes out until you schedule it.`, '<button class="eh-btn eh-o eh-s" type="button" data-act="nav" data-page="campaigns">&larr; All campaigns</button>') + kindTabs('text') + `<div class="eh-comp"><div class="eh-comp-l">
      ${restored ? '<p class="eh-flash" role="status" style="margin:0">Picked up where you left off. <button type="button" class="eh-link" data-act="fresh">Start a new one</button></p>' : ''}
      ${step(1, 'Who it is for', 'Everyone on your list, or one group.', '<div class="eh-field" style="margin:0"><label for="eh-to">Send to</label><select id="eh-to"><option value="">Everyone on your list</option></select><p class="eh-small" id="eh-to-n" style="margin:.5rem 0 0"></p></div>' + templatePicker(st.newTemplate))}
      ${step(2, 'Subject and preview', 'The two lines a person reads before they open it.', `<div class="eh-field"><div class="eh-lab"><label for="eh-sub">Subject line</label><span class="eh-count" id="eh-sub-n"></span></div><input id="eh-sub" type="text" maxlength="150" autocomplete="off" style="font-size:calc(1.05rem*var(--eh-scale,1))"></div>
        <div class="eh-field"><div class="eh-lab"><label for="eh-pre">Preview text</label><span class="eh-count" id="eh-pre-n"></span></div><input id="eh-pre" type="text" maxlength="150" autocomplete="off" placeholder="The line after the subject in an inbox"></div>
        <div class="eh-emoji-box"><button type="button" class="eh-link eh-emoji-toggle" data-act="emoji-toggle" aria-expanded="${emojiOpen}" aria-controls="eh-emoji-tray"><span aria-hidden="true">&#128578;</span> Add an emoji <span class="eh-caret" aria-hidden="true">&#9662;</span></button><div id="eh-emoji-tray" class="${emojiOpen ? '' : 'eh-hide'}"><p class="eh-small eh-muted" style="margin:.6rem 0 0">Goes wherever you were last typing.</p><div class="eh-emoji" role="group" aria-label="Emoji">${emoji.map((x) => `<button type="button" data-act="emoji" aria-label="Add ${x}">${x}</button>`).join('')}</div><p class="eh-small eh-muted" style="margin:.5rem 0 0">For any other emoji: on a Mac press Control + Command + Space; on Windows press the Windows key + period.</p></div>`)}
      ${step(3, 'The email', 'Write it plainly, or paste a finished email as HTML.', `<div class="eh-tabs" role="tablist" aria-label="How to make the email" style="margin:0 0 .8rem"><button type="button" class="eh-btn eh-o eh-s" role="tab" data-act="body-mode" data-mode="text" aria-selected="${st.bodyMode !== 'html'}">Write it</button><button type="button" class="eh-btn eh-o eh-s" role="tab" data-act="body-mode" data-mode="html" aria-selected="${st.bodyMode === 'html'}">Paste HTML</button></div>
        <div id="eh-html-box" class="${st.bodyMode === 'html' ? '' : 'eh-hide'}"><div class="eh-field"><div class="eh-lab"><label for="eh-html">HTML of the whole email</label><span class="eh-count" id="eh-html-n"></span></div><textarea id="eh-html" rows="14" maxlength="200000" spellcheck="false" placeholder="&lt;html&gt; &hellip; &lt;/html&gt;" style="font-family:ui-monospace,Menlo,monospace;font-size:.85rem"></textarea><p class="eh-small eh-muted" style="margin:.4rem 0 0">It is sent exactly as pasted, so your logo, footer and postal address are <strong>not</strong> added. It must contain the unsubscribe tag <code>${esc(st.mergeTags?.unsubscribe || '')}</code> (as a link&rsquo;s address) or it will not save. Scripts, forms and frames are removed. Pictures need full https:// addresses.</p></div></div>
        <div id="eh-text-box" class="${st.bodyMode === 'html' ? 'eh-hide' : ''}"><div class="eh-field"><div class="eh-lab"><label for="eh-text">Message</label><span class="eh-count" id="eh-words"></span></div><textarea id="eh-text" rows="14" maxlength="20000" placeholder="Write it plainly.&#10;&#10;A blank line starts a new paragraph. Links like https://example.org work as they are.&#10;&#10;Your logo, footer and unsubscribe line are added for you."></textarea><p class="eh-small eh-muted" style="margin:.4rem 0 0">Want it designed, with pictures and buttons? Save the draft, then use &ldquo;Edit the design in ${esc(st.label)}&rdquo; on it. The logo, colours and footer are set under Content.</p></div></div>
        <div class="eh-field" style="margin:0;padding-top:1rem;border-top:1px solid var(--eh-rule)"><label for="eh-title">Name in ${esc(st.label)} <span class="eh-muted" style="text-transform:none;letter-spacing:0">(optional)</span></label><input id="eh-title" type="text" maxlength="100" autocomplete="off" placeholder="Defaults to the subject line"></div>`)}
      <div class="eh-row"><button class="eh-btn" type="button" data-act="save-draft">Save draft to ${esc(st.label)}</button><button class="eh-btn eh-o" type="button" data-act="nav" data-page="campaigns">Cancel</button><span class="eh-small eh-muted">Nothing is sent. You schedule it from Campaigns, after a look.</span></div><p class="eh-msg" id="eh-msg" role="status" aria-live="polite"></p></div>
      <aside class="eh-comp-r" aria-label="Preview"><div class="eh-tabs" role="tablist" aria-label="Preview as"><button type="button" class="eh-btn eh-o eh-s" role="tab" data-act="pv" data-pv="inbox" aria-selected="${st.pv === 'inbox'}">In the inbox</button><button type="button" class="eh-btn eh-o eh-s" role="tab" data-act="pv" data-pv="open" aria-selected="${st.pv === 'open'}">Opened</button></div>
        <div id="eh-pv-inbox" class="${st.pv === 'inbox' ? '' : 'eh-hide'}"><div class="eh-inbox"><div class="eh-inbox-top"><b><i aria-hidden="true"></i>${esc(brandName || 'Your name')}</b><span>now</span></div><p class="eh-inbox-sub" id="eh-pv-sub"></p><p class="eh-inbox-pre" id="eh-pv-pre"></p><p class="eh-inbox-note eh-hide" id="eh-pv-note">Dimmed text may be cut off on a phone.</p></div></div>
        <div id="eh-pv-open" class="eh-frame-box ${st.pv === 'open' ? '' : 'eh-hide'}"><div class="eh-frame-head"><small>FROM ${esc((brandName || 'you').toUpperCase())}</small><b id="eh-pv-fsub"></b></div><iframe id="eh-pv-frame" class="eh-frame" sandbox="allow-same-origin" title="Preview of the email"></iframe></div></aside></div>`;
    if (kept) { $('#eh-sub').value = kept.s || ''; $('#eh-pre').value = kept.p || ''; $('#eh-title').value = kept.t || ''; $('#eh-text').value = kept.x || ''; $('#eh-html').value = kept.h || ''; }
    $('#eh-pv-frame').addEventListener('load', () => fit($('#eh-pv-frame')));
    preview(); $('#eh-sub').focus();
    const [a, l] = await Promise.all([st.audience?.tags ? st.audience : api('/audience').catch(() => null), st.look ? st.look : api('/look').catch(() => null)]);
    if (!$('#eh-to')) return;
    if (a && a.connected !== false) {
      st.audience = a; const opt = (v, n, c) => `<option value="${v}" data-n="${c ?? ''}">${esc(n)}${c != null ? ` (${c})` : ''}</option>`;
      $('#eh-to').innerHTML = opt('', 'Everyone on your list', a.subscribers) + (a.tags?.length ? `<optgroup label="A tag">${a.tags.map((t) => opt('t:' + t.id, t.name, t.count)).join('')}</optgroup>` : '') + (a.segments?.length ? `<optgroup label="A saved group">${a.segments.map((t) => opt('s:' + t.id, t.name, t.count)).join('')}</optgroup>` : '');
      if (kept?.to) $('#eh-to').value = kept.to; $('#eh-to').dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (l) { st.look = l; preview(); }
  }
  function preview() {
    if (!$('#eh-sub')) return;
    const s = $('#eh-sub').value, p = $('#eh-pre').value, x = $('#eh-text').value, hh = $('#eh-html').value, sc = chars(s), pc = chars(p), words = x.trim() ? x.trim().split(/\s+/).length : 0;
    const asHtml = st.bodyMode === 'html'; $('#eh-html-n').textContent = hh.trim() ? `${hh.length.toLocaleString('en-AU')} characters` : '';
    $('#eh-sub-n').textContent = `${sc.length} ${sc.length === 1 ? 'character' : 'characters'}${sc.length > SUBJECT_SOFT ? ' · some inboxes may cut it off' : ''}`; $('#eh-sub-n').classList.toggle('eh-over', sc.length > SUBJECT_SOFT);
    $('#eh-pre-n').textContent = `${pc.length} ${pc.length === 1 ? 'character' : 'characters'}${pc.length > PREVIEW_SOFT ? ' · some inboxes may cut it off' : ''}`; $('#eh-pre-n').classList.toggle('eh-over', pc.length > PREVIEW_SOFT);
    $('#eh-words').textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
    const h = sc.slice(0, 45).join(''), t = sc.slice(45).join('');
    $('#eh-pv-sub').innerHTML = sc.length ? `${esc(h)}${t ? `<span class="dim">${esc(t)}</span>` : ''}` : '<span class="eh-ph">Subject line</span>';
    $('#eh-pv-pre').innerHTML = p ? esc(p) : '<span class="eh-ph">Preview text</span>'; $('#eh-pv-note').classList.toggle('eh-hide', !t); $('#eh-pv-fsub').textContent = s || 'Subject line';
    if (st.pv === 'open') $('#eh-pv-frame').srcdoc = asHtml ? (hh.trim() ? cleanHtml(hh) : '<p style="font-family:sans-serif;padding:1rem;color:#666">The email you paste appears here.</p>') : bodyHtml(x || 'Your words appear here.', { style: st.look?.style, address: st.look?.mergePreview?.address || 'Your postal address', unsubscribe: '#', brand: { style: st.look?.defaults } });
    try { localStorage.setItem(draftKey, JSON.stringify({ s, p, t: $('#eh-title').value, x, h: hh, mode: st.bodyMode, to: $('#eh-to').value })); } catch { /* fine without it */ }
  }
  function insert(ch) {
    const id = st.last || 'eh-sub', el = $('#' + id); if (!el) return;
    const cap = id === 'eh-text' ? 20000 : 150, a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
    const put = id !== 'eh-text' && !/\s/.test(el.value.slice(b, b + 1)) ? `${ch} ` : ch;
    el.value = clip(el.value.slice(0, a) + put + el.value.slice(b), cap); el.focus();
    const pos = a + put.length; try { el.setSelectionRange(pos, pos); } catch { /* not a text field */ } preview();
  }
  async function saveDraft(btn) {
    const msg = $('#eh-msg'); btn.disabled = true; say(msg, `Saving to ${st.label}…`);
    try {
      const tpl = $('#eh-tpl')?.value, dflt = st.tpls?.find((x) => x.isDefault)?.id || '';
      const d = await api('/campaigns', { method: 'POST', body: JSON.stringify({ subject: $('#eh-sub').value, previewText: $('#eh-pre').value, title: $('#eh-title').value, ...(st.bodyMode === 'html' ? { html: $('#eh-html').value } : { text: $('#eh-text').value }), to: $('#eh-to').value, ...(tpl && String(tpl) !== String(dflt) ? { templateId: tpl } : {}) }) });
      st.newTemplate = '';
      try { localStorage.removeItem(draftKey); } catch { /* nothing to clear */ }
      st.filter = 'draft'; st.open = d.campaign.id; st.mode = null; st.page = 'campaigns'; st.sub = ''; renderNav();
      await campaigns(); flash(`Saved as a draft in ${st.label}. Have a look, send yourself a test, then schedule it when you are happy.` + (d.warnings?.length ? ' Worth a look first: ' + d.warnings.join(' ') : ''));
    } catch (err) { say(msg, err.message, true); btn.disabled = false; }
  }

  /* ---- Templates: the service's own designs, chosen for an email ---- */
  async function loadTemplates() {
    if (st.tpls) return st.tpls;
    if (!st.caps.templates) return (st.tpls = []);
    try { st.tpls = (await api('/templates')).templates || []; } catch { st.tpls = []; }
    return st.tpls;
  }
  /* "Design" chooser for a new email. Only when there is a real choice. */
  const templatePicker = (selected = '') => (st.tpls?.length > 1 || (st.tpls?.length === 1 && !st.tpls[0].isDefault)
    ? `<div class="eh-field" style="margin:.9rem 0 0"><label for="eh-tpl">Design</label><select id="eh-tpl">${st.tpls.some((t) => t.isDefault) ? '' : `<option value=""${selected ? '' : ' selected'}>Standard (no template)</option>`}${st.tpls.map((t) => `<option value="${esc(t.id)}"${String(t.id) === String(selected || st.tpls.find((x) => x.isDefault)?.id || '') ? ' selected' : ''}>${esc(t.name)}${t.isDefault ? ' (default)' : ''}</option>`).join('')}</select><p class="eh-small eh-muted" style="margin:.4rem 0 0">The ${esc(st.label)} template it is sent in. Most emails use the default. See them all under Content.</p></div>`
    : '');
  const templateBox = (c) => `<div class="eh-box"><div class="eh-field"><label for="tp-sel">Design this email is sent in</label><select id="tp-sel">${(st.tpls || []).map((t) => `<option value="${esc(t.id)}"${String(t.id) === String(st.tplOf?.[c.id]) ? ' selected' : ''}>${esc(t.name)}${t.isDefault ? ' (default)' : ''}</option>`).join('')}</select></div><div class="eh-row"><button class="eh-btn eh-s" type="button" data-act="tpl-save" data-id="${esc(c.id)}">Use this design</button><button class="eh-btn eh-o eh-s" type="button" data-act="mode-x">Cancel</button></div><p class="eh-small eh-muted" style="margin:.5rem 0 0">Changes how ${esc(st.label)} wraps the email. The preview above shows it once saved.</p></div>`;

  /* ---- Create email from a host's layout (a show announcement): fields in, the whole email out ---- */
  async function loadLayouts() {
    if (st.layouts) return st.layouts;
    try { st.layouts = await api('/layouts'); } catch { st.layouts = { enabled: false, layouts: [] }; }
    return st.layouts;
  }
  /* "Write it" and each layout the host offers, as the first choice on Create. Nothing when there are none. */
  const kindTabs = (current) => (st.layouts?.enabled && st.layouts.layouts.length
    ? `<div class="eh-tabs" role="tablist" aria-label="What kind of email" style="margin:0 0 1rem"><button type="button" class="eh-btn eh-o eh-s" role="tab" data-act="kind" data-kind="text" aria-selected="${current === 'text'}">Write it</button>${st.layouts.layouts.map((l) => `<button type="button" class="eh-btn eh-o eh-s" role="tab" data-act="kind" data-kind="${esc(l.id)}" aria-selected="${current === l.id}">${esc(l.label)}</button>`).join('')}</div>`
    : '');
  const layoutValues = () => Object.fromEntries((st.lay?.def?.fields || []).map((f) => [f.key, $('#lf-' + f.key)?.value ?? '']));
  async function composeLayout(layoutId, edit = null) {
    await loadLayouts();
    const def = st.layouts.layouts.find((x) => x.id === layoutId); if (!def) return compose();
    st.lay = { id: layoutId, def, edit };
    const v = edit?.values || {}, c = edit?.campaign || {};
    const groups = [];
    for (const f of def.fields) { const name = f.group || 'Details'; let g = groups.find((x) => x.name === name); if (!g) groups.push(g = { name, fields: [] }); g.fields.push(f); }
    const opt = (f) => (f.required ? '' : ' <span class="eh-muted" style="text-transform:none;letter-spacing:0">(optional)</span>');
    const input = (f) => `<div class="eh-field"><div class="eh-lab"><label for="lf-${esc(f.key)}">${esc(f.label)}${opt(f)}</label></div>${f.type === 'longtext'
      ? `<textarea id="lf-${esc(f.key)}" rows="6" placeholder="${esc(f.placeholder)}">${esc(v[f.key] ?? '')}</textarea>`
      : `<input id="lf-${esc(f.key)}" type="${f.type === 'url' ? 'url' : 'text'}" autocomplete="off" placeholder="${esc(f.placeholder)}" value="${esc(v[f.key] ?? '')}">`}${f.hint ? `<p class="eh-small eh-muted" style="margin:.3rem 0 0">${esc(f.hint)}</p>` : ''}</div>`;
    let n = 0;
    const lead = edit?.copied ? 'This is a copy, with every field already filled in. Change what is different, then save.' : edit ? 'Change any field. The design stays the same.' : (def.description || 'Fill in the details. The design is always the same.');
    main().innerHTML = head(edit ? (edit.copied ? 'Change the copy' : 'Edit details') : def.label, lead, '<button class="eh-btn eh-o eh-s" type="button" data-act="nav" data-page="campaigns">&larr; All campaigns</button>') + (edit ? '' : kindTabs(layoutId)) + `<div class="eh-comp"><div class="eh-comp-l">
      ${edit ? '' : step(++n, 'Who it is for', 'Everyone on your list, or one group.', '<div class="eh-field" style="margin:0"><label for="ly-to">Send to</label><select id="ly-to"><option value="">Everyone on your list</option></select><p class="eh-small" id="ly-to-n" style="margin:.5rem 0 0"></p></div>')}
      ${step(++n, 'Subject and preview', 'The two lines a person reads before they open it.', `<div class="eh-field"><div class="eh-lab"><label for="ly-sub">Subject line</label></div><input id="ly-sub" type="text" maxlength="150" autocomplete="off" value="${esc(c.subject || '')}"></div>
        <div class="eh-field"><div class="eh-lab"><label for="ly-pre">Preview text</label></div><input id="ly-pre" type="text" maxlength="150" autocomplete="off" placeholder="The line after the subject in an inbox" value="${esc(c.preview || '')}"></div>
        <div class="eh-field" style="margin:0"><label for="ly-title">Name in ${esc(st.label)} <span class="eh-muted" style="text-transform:none;letter-spacing:0">(optional)</span></label><input id="ly-title" type="text" maxlength="100" autocomplete="off" value="${esc(c.title && c.title !== c.subject ? c.title : '')}"></div>`)}
      ${groups.map((g) => step(++n, esc(g.name), '', g.fields.map(input).join(''))).join('')}
      <div class="eh-row"><button class="eh-btn" type="button" data-act="save-layout">${edit ? 'Save changes' : `Save draft to ${esc(st.label)}`}</button><button class="eh-btn eh-o" type="button" data-act="nav" data-page="campaigns">Cancel</button><span class="eh-small eh-muted">Nothing is sent. You schedule it from Campaigns, after a look.</span></div><p class="eh-msg" id="eh-msg" role="status" aria-live="polite"></p></div>
      <aside class="eh-comp-r" aria-label="Preview"><div class="eh-frame-box"><div class="eh-frame-head"><small>FROM ${esc((brandName || 'you').toUpperCase())}</small><b id="ly-fsub"></b></div><iframe id="ly-frame" class="eh-frame" sandbox="allow-same-origin" title="Preview of the email"></iframe></div></aside></div>`;
    $('#ly-frame').addEventListener('load', () => { fit($('#ly-frame')); picturesNote($('#ly-frame')); });
    layoutPreview(true);
    if (edit) return;
    const a = st.audience?.tags ? st.audience : await api('/audience').catch(() => null);
    if (!$('#ly-to') || !a || a.connected === false) return;
    st.audience = a; const o = (val, name, k) => `<option value="${val}" data-n="${k ?? ''}">${esc(name)}${k != null ? ` (${k})` : ''}</option>`;
    $('#ly-to').innerHTML = o('', 'Everyone on your list', a.subscribers) + (a.tags?.length ? `<optgroup label="A tag">${a.tags.map((t) => o('t:' + t.id, t.name, t.count)).join('')}</optgroup>` : '') + (a.segments?.length ? `<optgroup label="A saved group">${a.segments.map((t) => o('s:' + t.id, t.name, t.count)).join('')}</optgroup>` : '');
  }
  /* The whole email, made by the host's layout on the server from what is typed so far. */
  function layoutPreview(now = false) {
    clearTimeout(st.lyT);
    const run = async () => {
      const fsub = $('#ly-fsub'); if (!fsub || !st.lay) return;
      fsub.textContent = $('#ly-sub')?.value || 'Subject line';
      try { const d = await api(`/layouts/${st.lay.id}/render`, { method: 'POST', body: JSON.stringify({ values: layoutValues() }) }); if ($('#ly-frame')) $('#ly-frame').srcdoc = d.html; }
      catch (err) { if ($('#ly-frame')) $('#ly-frame').srcdoc = `<p style="font-family:sans-serif;padding:1rem">${esc(err.message)}</p>`; }
    };
    if (now) return run();
    st.lyT = setTimeout(run, 350);
  }
  async function saveLayout(btn) {
    const msg = $('#eh-msg'), edit = st.lay.edit; btn.disabled = true; say(msg, `Saving to ${st.label}…`);
    try {
      const base = { subject: $('#ly-sub').value, previewText: $('#ly-pre').value, title: $('#ly-title').value };
      const d = edit
        ? await api(`/campaigns/${edit.id}`, { method: 'PATCH', body: JSON.stringify({ ...base, layoutValues: layoutValues() }) })
        : await api('/campaigns', { method: 'POST', body: JSON.stringify({ ...base, layout: st.lay.id, values: layoutValues(), to: $('#ly-to').value }) });
      const id = d.campaign?.id || edit?.id;
      const l = await api('/campaigns'); st.all = l.campaigns;
      st.filter = 'draft'; st.open = id; st.mode = null; st.page = 'campaigns'; st.sub = ''; st.lay = null; renderNav();
      await campaigns(); flash(edit ? 'Saved. Have a look at the preview below.' : `Saved as a draft in ${st.label}. Have a look, send yourself a test, then schedule it when you are happy.`);
    } catch (err) { say(msg, err.message, true); btn.disabled = false; }
  }
  /* Opens a draft's fields for editing (from Review, or straight after Duplicate). */
  async function editFields(id, copied = false) {
    const lay = await api(`/campaigns/${id}/layout`); if (!lay.layout) throw new Error('That email has no fields to edit.');
    let c = findEmail(id); if (!c) { const l = await api('/campaigns'); st.all = l.campaigns; c = findEmail(id); }
    return composeLayout(lay.layout, { id, values: lay.values, campaign: c || {}, copied });
  }

  /* ---- Audience ---- */
  async function audience() {
    if (!st.caps.contacts) { main().innerHTML = head('Audience', 'Everyone you can email.', appLink('/lists/')) + '<div class="eh-card"><p class="eh-small eh-muted" style="margin:0">Contacts are managed in ' + esc(st.label) + '.</p></div>'; return; }
    const sub = audienceTabs().some(([k]) => k === st.sub) ? st.sub : 'contacts';
    const a = await api('/audience'); if (a.connected === false) { main().innerHTML = off(); return; }
    st.audience = a;
    main().innerHTML = head('Audience', 'Everyone you can email, and how they are grouped.', appLink('/lists/')) + '<div id="eh-aud"></div>';
    st.sub = sub; renderNav();
    if (sub === 'contacts') await contacts(true); else if (sub === 'tags') tagsView(); else if (sub === 'segments') segments(); else if (sub === 'fields') await fieldsView(); else importView();
  }
  async function contacts(withCounts) {
    const p = st.ppl, box = $('#eh-aud'), tags = st.audience?.tags || [];
    box.innerHTML = '<p class="eh-muted">Loading…</p>';
    const qs = new URLSearchParams({ status: p.status }); if (p.tag) qs.set('tag', p.tag); if (p.email) qs.set('email', p.email); if (p.after) qs.set('after', p.after); if (withCounts || !p.counts) qs.set('counts', '1');
    let d; try { d = await api('/contacts?' + qs); } catch (err) { box.innerHTML = fail(err); return; }
    if (d.counts) p.counts = d.counts;
    box.innerHTML = `<div class="eh-tabs">${Object.entries(STATE).map(([k, l]) => `<button type="button" class="eh-btn eh-o eh-s" data-act="pstate" data-s="${k}" aria-selected="${p.status === k && !p.email && !p.tag}">${l} <span style="opacity:.7">${num(p.counts?.[k])}</span></button>`).join('')}</div>
      <div class="eh-toolbar"><select id="eh-ptag" aria-label="Filter by tag"><option value="">All tags</option>${tags.map((t) => `<option value="${esc(t.id)}"${String(p.tag) === String(t.id) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <form id="eh-pfind" class="eh-find"><input id="eh-pemail" type="search" placeholder="Find by full email" aria-label="Find one person by email" value="${esc(p.email)}"><button class="eh-btn eh-o eh-s" type="submit">Find</button></form><button class="eh-btn eh-s" type="button" data-act="padd">Add contact</button></div>
      <div id="eh-padd"></div>
      <p class="eh-small eh-muted" style="margin:0 0 .5rem">${p.email ? 'Search result' : `${num(d.total)} ${p.tag ? 'with that tag' : (STATE[p.status] || '').toLowerCase()}`}</p>
      ${d.contacts.length ? `<ul class="eh-people">${d.contacts.map((c) => `<li><button type="button" class="eh-person" data-act="popen" data-id="${esc(c.id)}" aria-expanded="${p.open === c.id}"><span><span>${esc([c.first, c.last].filter(Boolean).join(' ') || '—')}</span><small>${esc(c.email)}</small></span><span class="eh-hide-s eh-small eh-muted">${esc(short(c.created))}</span><span class="eh-tag ${esc(c.state)}">${esc(STATE[c.state] || c.state)}</span></button>${p.open === c.id ? '<div class="eh-drawer" id="eh-drawer">Loading…</div>' : ''}</li>`).join('')}</ul>` : '<p class="eh-muted">No one here.</p>'}
      ${!p.email && (p.stack.length || d.next) ? `<div class="eh-row" style="margin-top:1rem"><button class="eh-btn eh-o eh-s" type="button" data-act="ppage" data-d="-1" ${p.stack.length ? '' : 'disabled'}>&larr; Previous</button><button class="eh-btn eh-o eh-s" type="button" data-act="ppage" data-d="1" data-next="${esc(d.next || '')}" ${d.next ? '' : 'disabled'}>Next &rarr;</button></div>` : ''}`;
    if (p.open) drawer(p.open);
  }
  async function drawer(id) {
    const box = $('#eh-drawer'); if (!box) return;
    try {
      const c = await api('/contacts/' + id); const has = new Set(c.tags.map((t) => t.name)), tags = (st.audience?.tags || []).filter((t) => !has.has(t.name));
      box.innerHTML = `<p style="margin:0 0 .4rem"><strong>${esc([c.first, c.last].filter(Boolean).join(' ') || 'No name')}</strong> <span class="eh-muted">· ${esc(STATE[c.state] || c.state)}</span></p><p class="eh-small eh-muted" style="margin:0 0 .8rem">${c.joined ? `Joined ${esc(short(c.joined))}` : ''}${c.source ? ` · came in through ${esc(c.source)}` : ''}</p>
        ${st.caps.tags ? `<div class="eh-small eh-muted">Tags</div><div class="eh-chips">${c.tags.length ? c.tags.map((t) => `<span class="eh-chip">${esc(t.name)}<button type="button" data-act="untag" data-name="${esc(t.name)}" aria-label="Remove tag ${esc(t.name)}">&times;</button></span>`).join('') : '<span class="eh-small eh-muted">None.</span>'}</div>` : ''}
        <div class="eh-row">${st.caps.tags ? `<select id="eh-addtag" aria-label="Add a tag" style="max-width:14rem;width:auto"><option value="">Add a tag…</option>${tags.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}</select><button class="eh-btn eh-o eh-s" type="button" data-act="tag">Add</button>` : ''}${c.state === 'subscribed' ? '<button class="eh-btn eh-danger eh-s" type="button" data-act="unsub">Unsubscribe</button>' : ''}<button class="eh-btn eh-o eh-s" type="button" data-act="pclose">Close</button></div><p class="eh-msg" id="eh-dmsg" role="status"></p>`;
    } catch (err) { box.innerHTML = fail(err); }
  }
  function addForm() {
    $('#eh-padd').innerHTML = `<div class="eh-card" style="margin:0 0 1rem;max-width:40rem"><h3>Add a contact</h3><div class="eh-two" style="gap:1rem"><div class="eh-field"><label for="ac-e">Email</label><input id="ac-e" type="email" autocomplete="off"></div><div class="eh-field"><label for="ac-f">First name</label><input id="ac-f" type="text" autocomplete="off"></div></div>
      ${st.caps.tags ? `<div class="eh-field"><label for="ac-t">Tag <span class="eh-muted" style="text-transform:none;letter-spacing:0">(optional)</span></label><select id="ac-t"><option value="">No tag</option>${(st.audience?.tags || []).map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}</select></div>` : ''}
      <label class="eh-check" style="margin-bottom:.8rem"><input type="checkbox" id="ac-c"><span>This person agreed to hear from me by email.</span></label><div class="eh-row"><button class="eh-btn eh-s" type="button" data-act="padd-go">Add contact</button><button class="eh-btn eh-o eh-s" type="button" data-act="padd-x">Cancel</button><span class="eh-msg" id="ac-m" role="status"></span></div></div>`;
    $('#ac-e').focus();
  }
  function tagsView() {
    const tags = st.audience?.tags || [], max = Math.max(1, ...tags.map((t) => t.count || 0));
    $('#eh-aud').innerHTML = `<form id="eh-newtag" class="eh-row" style="margin:0 0 1.2rem"><input id="eh-tagname" type="text" aria-label="New tag name" placeholder="New tag, e.g. Workshop 2026" style="max-width:18rem"><button class="eh-btn eh-s" type="submit">Create tag</button><span class="eh-msg" id="eh-tagmsg" role="status"></span></form>${tags.length ? bars(tags.map((t) => [t.name, t.count, num(t.count)]), max) : '<p class="eh-muted">No tags yet.</p>'}<p class="eh-small eh-muted" style="max-width:60ch;margin-top:1rem">A tag is a label on a person. Send an email to one tag from Create. A tag can include people who have since unsubscribed; they are never emailed.</p>`;
  }
  function segments() {
    const seg = st.audience?.segments || [];
    $('#eh-aud').innerHTML = `${seg.length ? `<ul class="eh-people">${seg.map((s) => `<li><div class="eh-person eh-static"><span>${esc(s.name)}</span><span class="eh-small eh-muted eh-hide-s">${num(s.count)} people</span><span></span></div></li>`).join('')}</ul>` : '<p class="eh-muted">No saved groups yet.</p>'}<p class="eh-small eh-muted" style="max-width:60ch;margin-top:1rem">Segments are saved searches. They are built in ${esc(st.label)}, where the filters live, and listed here so you can send to one from Create.</p><div style="margin-top:.6rem">${appLink('/lists/', `Build a segment in ${st.label}`)}</div>`;
  }
  async function fieldsView() {
    const d = await api('/fields');
    $('#eh-aud').innerHTML = `<ul class="eh-people">${d.fields.map((f) => `<li><div class="eh-person eh-static"><span>${esc(f.name)}<small>${esc(f.tag)} · ${esc(f.type)}</small></span><span class="eh-small eh-muted eh-hide-s">${f.required ? 'Required' : ''}</span><span></span></div></li>`).join('')}</ul>`;
  }
  function importView() {
    $('#eh-aud').innerHTML = `<div class="eh-card" style="max-width:44rem"><h3>Import contacts</h3><p class="eh-small eh-muted" style="margin:0 0 .8rem">Choose a CSV file with an email column (and, if you have them, first and last names). Up to 5,000 people at a time.</p>
      <input type="file" id="eh-csv" accept=".csv,text/csv" style="width:100%"><div id="eh-csv-info" class="eh-small" style="margin:.6rem 0"></div>
      <div class="eh-field"><label for="eh-csv-tag">Tag everyone with <span class="eh-muted" style="text-transform:none;letter-spacing:0">(optional)</span></label><input id="eh-csv-tag" type="text" maxlength="100" placeholder="e.g. Workshop 2026" style="max-width:18rem"></div>
      <fieldset style="border:0;padding:0;margin:0 0 1rem"><label class="eh-check" style="margin-bottom:.4rem"><input type="radio" name="eh-agreed" value="yes"><span>Yes, they ticked a box to get emails from me. <span class="eh-muted">Added straight to your list.</span></span></label><label class="eh-check"><input type="radio" name="eh-agreed" value="no" checked><span>Not sure. <span class="eh-muted">${esc(st.label)} emails them to confirm first.</span></span></label></fieldset>
      <div class="eh-row"><button class="eh-btn" type="button" data-act="import-go" id="eh-import-go" disabled>Import</button><span class="eh-msg" id="eh-import-msg" role="status" aria-live="polite"></span></div></div>`;
  }

  /* ---- Analytics ---- */
  async function analytics() {
    const d = await overview(true); if (!d) return;
    const banner = extras.analyticsBanner ? await extras.analyticsBanner().catch(() => null) : null;
    const c = d.counts, sent = d.campaigns.filter((x) => x.status === 'sent'), best = Math.max(0.0001, ...sent.map((x) => x.openRate || 0));
    const period = (label, g, e) => `<div class="eh-card"><h3>${label}</h3><div class="eh-stats">${stat('Emails sent', num(e.data.emails), `${num(e.data.sent)} messages`)}${stat('Open rate', pct(e.data.openRate))}${stat('Click rate', pct(e.data.clickRate))}${g.ok ? stat('New contacts', num(g.data.added)) + stat('Unsubscribed', num(g.data.unsubscribed)) + stat('Net growth', g.data.net > 0 ? `+${g.data.net}` : String(g.data.net)) : ''}</div>${keptNote(e.data)}</div>`;
    const total = c.ok ? Object.values(c.data).reduce((a, b) => a + b, 0) : 0;
    main().innerHTML = head('Analytics', 'Growth and how each email did.', appLink('/reports/')) + (banner ? `<div class="eh-card" style="margin-bottom:1.4rem;display:flex;flex-wrap:wrap;gap:.6rem 1.2rem;align-items:center;justify-content:space-between"><span>${banner.html}</span><button type="button" class="eh-btn eh-o eh-s" data-act="banner">${esc(banner.label)}</button></div>` : '') + `<div class="eh-grid"><div class="eh-two">${period('Last 30 days', d.growth30, d.email30)}${period('Last 90 days', d.growth90, d.email90)}</div>
      <div class="eh-card"><h3>Who is on the list</h3>${c.ok ? bars(Object.entries(STATE).map(([k, l]) => [l, c.data[k], num(c.data[k])]), total) : fail(c.error)}</div>
      <div class="eh-card"><h3>Emails compared</h3>${sent.length ? sent.slice(0, 12).map((x) => `<div class="eh-bar2" style="grid-template-columns:minmax(6rem,16rem) minmax(0,1fr) 9rem"><button type="button" class="eh-link" data-act="goto" data-id="${esc(x.id)}">${esc(x.subject || x.title)}</button><span class="eh-trk" aria-hidden="true"><i style="width:${Math.round(100 * (x.openRate || 0) / best)}%"></i></span><span class="eh-n eh-small eh-muted">${pct(x.openRate)} opened · ${pct(x.clickRate)} clicked</span></div>`).join('') : '<p class="eh-small eh-muted" style="margin:0">Nothing has been sent yet. Once an email goes out, opens and clicks show here.</p>'}</div></div>`;
    st.banner = banner;
  }

  /* ---- Content: the look of every email ---- */
  async function content() {
    const d = await api('/look'); st.look = d; st.lookDraft = { ...d.style };
    main().innerHTML = head('Content', 'The look of every email you write here.', appLink('/templates/', `Templates in ${st.label}`)) + `<div class="eh-card"><h3>Email look</h3><div class="eh-look"><div>
      <div class="eh-small eh-muted">Logo</div><div class="eh-logos">${d.logos.map((l) => `<div class="eh-logo-wrap"><button type="button" class="eh-logo" data-act="logo" data-url="${esc(l.url)}" aria-pressed="${l.url === st.lookDraft.logoUrl}"><span><img src="${esc(l.preview || l.url)}" alt=""></span><small>${esc(l.name)}</small></button>${d.canDelete && !l.builtin ? `<button type="button" class="eh-logo-x" data-act="logo-del" data-id="${esc(l.id)}" data-name="${esc(l.name)}" aria-label="Delete ${esc(l.name)}">&times;</button>` : ''}</div>`).join('')}</div>
      ${d.canUpload ? `<label class="eh-btn eh-o eh-s" style="margin:.3rem 0 .4rem;cursor:pointer"><span id="lk-up-t">Upload a new logo</span><input type="file" id="lk-up" accept="${esc((d.upload?.types || []).join(','))}" class="eh-sr"></label><p class="eh-small eh-muted" style="margin:0 0 .6rem">${esc((d.upload?.types || []).map((t) => t.replace('image/', '').toUpperCase()).join(', '))}, up to ${Math.round((d.upload?.maxBytes || 2e6) / 1e5) / 10} MB.</p>` : ''}
      ${options.logoHelp ? `<p class="eh-small eh-muted" style="margin:.2rem 0 1rem">${esc(options.logoHelp)}</p>` : ''}
      <div class="eh-field"><label for="lk-w">Logo width: <span id="lk-wn">${st.lookDraft.logoWidth}</span>px</label><input id="lk-w" type="range" min="80" max="400" step="10" value="${st.lookDraft.logoWidth}" style="width:100%"></div>
      <div class="eh-small eh-muted" style="margin-bottom:.4rem">Colours</div><div class="eh-colors">${COLORS.map(([k, l]) => `<label><input type="color" data-k="${k}" value="${esc(st.lookDraft[k])}"><span>${l}<small>${esc(st.lookDraft[k])}</small></span></label>`).join('')}</div>
      ${fontChoice ? `<div class="eh-field" style="margin-top:1rem"><label for="lk-font">Words</label><select id="lk-font"><option value="sans"${(st.lookDraft.font || 'sans') === 'sans' ? ' selected' : ''}>Sans</option><option value="serif"${st.lookDraft.font === 'serif' ? ' selected' : ''}>Serif</option></select><p class="eh-small eh-muted" style="margin:.3rem 0 0">The typeface for the words of your emails.</p></div>` : ''}
      <div class="eh-field" style="margin-top:1rem"><label for="lk-f">Footer line</label><input id="lk-f" type="text" maxlength="120" value="${esc(st.lookDraft.footerLine)}"><p class="eh-small eh-muted" style="margin:.3rem 0 0">Sits above your address and the unsubscribe link, which every email carries and this cannot remove.</p></div>
      <div class="eh-field"><label for="lk-a">Postal address</label><textarea id="lk-a" rows="2" maxlength="200" placeholder="Street, suburb, state and postcode">${esc(st.lookDraft.address || '')}</textarea><p class="eh-small eh-muted" style="margin:.3rem 0 0">Shown at the bottom of every email. Leave it empty to use the address saved in your ${esc(st.label)} account.</p></div>
      <div class="eh-row"><button class="eh-btn" type="button" data-act="look-save">Save look</button><button class="eh-btn eh-o" type="button" data-act="look-reset">Put back the original</button><span class="eh-msg" id="lk-m" role="status" aria-live="polite"></span></div></div>
      <div><div class="eh-small eh-muted" style="margin-bottom:.4rem">Preview</div><div class="eh-frame-box"><iframe id="lk-pv" class="eh-frame" sandbox="allow-same-origin" title="Preview of the email look" style="height:34rem"></iframe></div><p class="eh-small eh-muted" style="margin-top:.5rem">Emails already scheduled or sent keep the look they were made with. Drafts keep theirs too; make a new one, or duplicate one, to pick up a change.</p></div></div></div>`;
    lookPreview();
    if (st.caps.templates) {
      try {
        st.tpls = null; const list = await loadTemplates();
        $('.eh-main').insertAdjacentHTML('beforeend', `<div class="eh-card" style="margin-top:1.4rem"><h3>Templates in ${esc(st.label)}</h3>${list.length ? `<ul class="eh-tpls">${list.map((x) => `<li><span class="eh-tpl-name">${x.thumbnail ? `<img src="${esc(x.thumbnail)}" alt="" width="56" height="56" style="object-fit:cover;object-position:top;border:1px solid var(--eh-rule);border-radius:var(--eh-radius)">` : ''}${esc(x.name)} ${x.isDefault ? '<span class="eh-tag">Default</span>' : ''}</span><span class="eh-row"><button type="button" class="eh-btn eh-o eh-s" data-act="tpl-preview" data-id="${esc(x.id)}">Preview</button><button type="button" class="eh-btn eh-o eh-s" data-act="tpl-use" data-id="${esc(x.id)}">Use for a new email</button></span></li>`).join('')}</ul><div id="tpl-pv"></div>` : '<p class="eh-small eh-muted" style="margin:0">No templates.</p>'}<p class="eh-small eh-muted" style="margin:.8rem 0 0">Designs an email is sent in. Choose one when you create an email, or change a draft&rsquo;s design from its Review. To edit a design, open it in ${esc(st.label)}.</p></div>`);
      } catch { /* the list is a courtesy; the screen works without it */ }
    }
  }
  function lookPreview() { const f = $('#lk-pv'); if (f) f.srcdoc = bodyHtml('Hello there,\n\nThis is how the words of an email sit on the card, with a link: https://example.org\n\nWarmly,\n' + (brandName || 'Your name'), { style: st.lookDraft, address: 'Your postal address', unsubscribe: '#', brand: { style: st.look?.defaults } }); }

  /* ---- events ---- */
  document.addEventListener('mousedown', outside); document.addEventListener('keydown', onKey);
  function closeMenus(except) { root.querySelectorAll('.eh-menu-list:not(.eh-hide)').forEach((m) => { if (m !== except) { m.classList.add('eh-hide'); m.parentElement.querySelector('.eh-more')?.setAttribute('aria-expanded', 'false'); } }); }
  function outside(e) { if (!e.target.closest?.('.eh-menu')) closeMenus(); }
  function onKey(e) { if (e.key === 'Escape') closeMenus(); }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !root.contains(b)) return; const a = b.dataset.act;
    if (a === 'menu') { const list = b.nextElementSibling; closeMenus(list); const show = list.classList.contains('eh-hide'); list.classList.toggle('eh-hide', !show); b.setAttribute('aria-expanded', String(show)); return; }
    closeMenus();
    if (a === 'nav') return go(b.dataset.page);
    if (a === 'create') return go('campaigns', 'new');
    if (a === 'fresh') { try { localStorage.removeItem(draftKey); } catch { /* nothing */ } return compose(); }
    if (a === 'refresh-list') return campaigns();
    if (a === 'goto') { st.open = b.dataset.id; st.filter = 'all'; st.q = ''; return go('campaigns'); }
    if (a === 'report') { st.reportId = b.dataset.id; return go('campaigns', 'report'); }
    if (a === 'filter') { st.filter = b.dataset.f; st.open = null; st.mode = null; return draw(false); }
    if (a === 'review') { st.open = st.open === b.dataset.id ? null : b.dataset.id; st.mode = null; return draw(false); }
    if (['m-preview', 'm-schedule', 'm-edit', 'm-template', 'tpl-save', 'm-test', 'm-delete', 'edit-save', 'test-send', 'dup', 'del', 'unsched', 'sched'].includes(a)) return act(a, b);
    if (a === 'tpl-preview') return (async () => {
      const box = $('#tpl-pv'); if (!box) return; box.innerHTML = '<p class="eh-small eh-muted">Loading&hellip;</p>';
      try {
        const d = await api(`/templates/${b.dataset.id}/preview`);
        box.innerHTML = d.imageUrl
          ? `<div class="eh-frame-box" style="margin-top:1rem"><div class="eh-frame-head"><small>PICTURE OF THE TEMPLATE</small><b>${esc(d.name)}</b></div><img src="${esc(d.imageUrl)}" alt="${esc(d.name)}" style="display:block;max-width:100%;margin:0 auto"></div>`
          : d.html
          ? `<div class="eh-frame-box" style="margin-top:1rem"><div class="eh-frame-head"><small>PREVIEW WITH A SAMPLE MESSAGE</small><b>${esc(d.name)}</b></div><iframe id="tpl-frame" class="eh-frame" sandbox="allow-same-origin" title="Preview of ${esc(d.name)}"></iframe></div>`
          : `<p class="eh-small eh-muted" style="margin-top:1rem"><b>${esc(d.name)}</b> has no preview copy on this site. Open it in ${esc(st.label)} to see it.</p>`;
        if (d.html && !d.imageUrl) { const f = $('#tpl-frame'); f.addEventListener('load', () => { fit(f); picturesNote(f); }); f.srcdoc = d.html; f.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      } catch (err) { box.innerHTML = `<p class="eh-msg eh-bad">${esc(err.message)}</p>`; }
    })();
    if (a === 'tpl-use') { st.newTemplate = b.dataset.id; return go('campaigns', 'new'); }
    if (a === 'kind') return b.dataset.kind === 'text' ? compose() : composeLayout(b.dataset.kind);
    if (a === 'save-layout') return saveLayout(b);
    if (a === 'edit-fields') return editFields(b.dataset.id).catch((err) => flash(err.message));
    if (a === 'mode-x') { st.mode = null; return draw(false); }
    if (a === 'emoji') return insert(b.textContent);
    if (a === 'emoji-toggle') { const open = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(open)); $('#eh-emoji-tray').classList.toggle('eh-hide', !open); return; }
    if (a === 'pv') { st.pv = b.dataset.pv; root.querySelectorAll('[data-act="pv"]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); $('#eh-pv-inbox').classList.toggle('eh-hide', st.pv !== 'inbox'); $('#eh-pv-open').classList.toggle('eh-hide', st.pv !== 'open'); return preview(); }
    if (a === 'save-draft') return saveDraft(b);
    if (a === 'body-mode') { st.bodyMode = b.dataset.mode; root.querySelectorAll('[data-act="body-mode"]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); $('#eh-html-box').classList.toggle('eh-hide', st.bodyMode !== 'html'); $('#eh-text-box').classList.toggle('eh-hide', st.bodyMode === 'html'); return preview(); }
    if (a === 'banner') return st.banner?.run?.();
    if (a === 'home-banner') return st.homeBanner?.run?.();
    if (a === 'asub') { st.sub = b.dataset.sub; return audience(); }
    if (a === 'pstate') { Object.assign(st.ppl, { status: b.dataset.s, tag: '', email: '', after: '', stack: [], open: null }); return contacts(true); }
    if (a === 'ppage') { const p = st.ppl; if (b.dataset.d === '1') { p.stack.push(p.after); p.after = b.dataset.next; } else p.after = p.stack.pop() || ''; p.open = null; return contacts(false); }
    if (a === 'popen') { st.ppl.open = st.ppl.open === b.dataset.id ? null : b.dataset.id; return contacts(false); }
    if (a === 'pclose') { st.ppl.open = null; return contacts(false); }
    if (a === 'padd') return addForm();
    if (a === 'padd-x') { $('#eh-padd').innerHTML = ''; return; }
    if (a === 'padd-go') {
      const m = $('#ac-m'); b.disabled = true;
      try { const r = await api('/contacts', { method: 'POST', body: JSON.stringify({ email: $('#ac-e').value, first: $('#ac-f').value, tag: $('#ac-t')?.value || '', consent: $('#ac-c').checked }) }); await audience(); flash(r.note || 'Added.'); }
      catch (err) { say(m, err.message, true); b.disabled = false; }
      return;
    }
    if (['tag', 'untag', 'unsub'].includes(a)) {
      const id = st.ppl.open, m = $('#eh-dmsg'); b.disabled = true;
      try {
        if (a === 'unsub') { if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Really unsubscribe?'; b.disabled = false; return; } await api(`/contacts/${id}/unsubscribe`, { method: 'POST' }); return contacts(true); }
        const name = a === 'tag' ? $('#eh-addtag').value : b.dataset.name; if (!name) { b.disabled = false; return; }
        await api(`/contacts/${id}/tags`, { method: a === 'tag' ? 'POST' : 'DELETE', body: JSON.stringify({ name }) }); return drawer(id);
      } catch (err) { say(m, err.message, true); b.disabled = false; return; }
    }
    if (a === 'import-go') {
      const m = $('#eh-import-msg'); b.disabled = true; say(m, `Sending to ${st.label}…`);
      try { const r = await api('/import', { method: 'POST', body: JSON.stringify({ people: st.csv.people, tag: $('#eh-csv-tag').value, agreed: root.querySelector('input[name="eh-agreed"]:checked')?.value === 'yes' }) }); say(m, `Sent ${r.count} people to ${st.label}${r.invalid ? ` (${r.invalid} rows were not valid addresses)` : ''}. They appear in your list in a few minutes.`); st.csv = null; }
      catch (err) { say(m, err.message, true); b.disabled = false; }
      return;
    }
    if (a === 'logo-del') {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '?'; b.title = `Really delete ${b.dataset.name}? Click again.`; setTimeout(() => { b.dataset.sure = ''; b.innerHTML = '&times;'; b.title = ''; }, 4000); return; }
      const m = $('#lk-m'); try { const r = await api('/look/logos/' + b.dataset.id, { method: 'DELETE' }); st.lookDraft = { ...r.style }; st.look = { ...st.look, style: r.style, logos: r.logos }; await content(); flash('Logo deleted.'); } catch (err) { say(m, err.message, true); }
      return;
    }
    if (a === 'logo') { st.lookDraft.logoUrl = b.dataset.url; root.querySelectorAll('[data-act="logo"]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); return lookPreview(); }
    if (a === 'look-save' || a === 'look-reset') {
      const m = $('#lk-m'); b.disabled = true; say(m, 'Saving…');
      try {
        if (a === 'look-reset' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Really put it back?'; b.disabled = false; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Put back the original'; }, 5000); say(m, ''); return; }
        const r = await api('/look', { method: 'PATCH', body: JSON.stringify(a === 'look-reset' ? { reset: true } : st.lookDraft) });
        st.look = { ...st.look, style: r.style }; st.lookDraft = { ...r.style }; if (a === 'look-reset') return content(); say(m, 'Saved. New emails use this look.'); lookPreview();
      } catch (err) { say(m, err.message, true); }
      b.disabled = false;
    }
  });
  root.addEventListener('focusin', (e) => { if (['eh-sub', 'eh-pre', 'eh-text'].includes(e.target.id)) st.last = e.target.id; });
  root.addEventListener('input', (e) => {
    const id = e.target.id;
    if (['eh-sub', 'eh-pre', 'eh-title', 'eh-text', 'eh-html'].includes(id)) return preview();
    if (id && (id.startsWith('lf-') || id === 'ly-sub')) return layoutPreview();
    if (id === 'eh-q') { st.q = e.target.value; return draw(false); }
    if (id === 'eh-when' || id === 'eh-ok') { const at = whenAt($('#eh-when').value), ok = Number.isFinite(at) && at >= Date.now() + st.sched.leadMinutes * 60000; $('#eh-when-note').textContent = Number.isFinite(at) ? (ok ? `It will go out ${when(new Date(at).toISOString())}.` : `Choose a time at least ${st.sched.leadMinutes} minutes from now.`) : ''; $('#eh-sched').disabled = !(ok && $('#eh-ok').checked); return; }
    if (id === 'lk-w') { st.lookDraft.logoWidth = Number(e.target.value); $('#lk-wn').textContent = e.target.value; return lookPreview(); }
    if (id === 'lk-f') { st.lookDraft.footerLine = e.target.value; return lookPreview(); }
    if (id === 'lk-a') { st.lookDraft.address = e.target.value; return lookPreview(); }
    if (e.target.dataset?.k) { st.lookDraft[e.target.dataset.k] = e.target.value.toUpperCase(); e.target.parentElement.querySelector('small').textContent = e.target.value.toUpperCase(); return lookPreview(); }
  });
  root.addEventListener('change', async (e) => {
    const id = e.target.id;
    if (id === 'eh-sort') { st.sort = e.target.value; return draw(false); }
    if (id === 'lk-font') { st.lookDraft.font = e.target.value; return lookPreview(); }
    if (id === 'eh-days') { st.days = Number(e.target.value); return home(); }
    if (id === 'eh-when' || id === 'eh-ok') return e.target.dispatchEvent(new Event('input', { bubbles: true }));
    if (id === 'eh-to') { const o = e.target.selectedOptions[0]; $('#eh-to-n').textContent = String(e.target.value).startsWith('s:') ? `${st.label} works out who is in this group at the moment it sends.` : o?.dataset.n ? `About ${Number(o.dataset.n).toLocaleString(locale)} ${Number(o.dataset.n) === 1 ? 'person' : 'people'} will get this.` : ''; return preview(); }
    if (id === 'eh-ptag') { Object.assign(st.ppl, { tag: e.target.value, email: '', after: '', stack: [], open: null }); return contacts(false); }
    if (id === 'lk-up') {
      const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const t = $('#lk-up-t'), m = $('#lk-m');
      const max = st.look?.upload?.maxBytes || 2_000_000; if (f.size > max) { say(m, `That picture is over ${Math.round(max / 1e5) / 10} MB.`, true); return; }
      t.textContent = 'Uploading…'; const fd = new FormData(); fd.append('file', f); fd.append('name', f.name);
      try {
        const res = await doFetch(base + '/look/logos', { method: 'POST', credentials: 'same-origin', body: fd }); const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'That did not go through.');
        await content(); st.lookDraft.logoUrl = body.logo.url; document.querySelectorAll('[data-act="logo"]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.url === body.logo.url))); lookPreview(); say($('#lk-m'), 'Uploaded. Choose Save look to use it in emails.');
      } catch (err) { t.textContent = 'Upload a new logo'; say(m, err.message, true); }
      return;
    }
    if (id === 'eh-csv') {
      const f = e.target.files?.[0], info = $('#eh-csv-info'); if (!f) return;
      if (f.size > 4_000_000) { info.textContent = 'That file is too large.'; return; }
      st.csv = parseCsv(await f.text()); const n = new Set(st.csv.people.map((p) => p.email.toLowerCase())).size;
      info.innerHTML = st.csv.people.length ? `Found <strong>${n}</strong> different addresses, reading emails from “${esc(st.csv.column)}”.` : `No email addresses found in ${esc(f.name)}. Is it a CSV export with an email column?`;
      $('#eh-import-go').disabled = !st.csv.people.length;
    }
  });
  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'eh-pfind') { Object.assign(st.ppl, { email: $('#eh-pemail').value.trim(), tag: '', after: '', stack: [], open: null }); return contacts(false); }
    if (e.target.id === 'eh-newtag') { const m = $('#eh-tagmsg'); try { await api('/tags', { method: 'POST', body: JSON.stringify({ name: $('#eh-tagname').value }) }); st.audience = await api('/audience'); tagsView(); $('#eh-tagmsg').textContent = 'Tag made.'; } catch (err) { say(m, err.message, true); } }
  });

  go('home');
  return { go, theme, refresh: () => { st.ov = null; return render(); }, destroy() { if (theme) theme.stop(); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', onKey); root.innerHTML = ''; root.classList.remove('eh'); } };
}
