/*
  A Kit (formerly ConvertKit) provider for the email hub (see ../provider.js for the contract). API v4.

    const provider = createKitProvider({ apiKey: env.KIT_API_KEY });

  This is the provider the hub's first host ran on, so the quirks below were met against a live account:

  - The hub speaks Mailchimp's words for a person's state (subscribed, unsubscribed, cleaned, pending); Kit's are
    active, cancelled, bounced and inactive (a held person Kit will not email until they opt in). Mapped both ways.
  - `POST /subscribers` is an upsert that NEVER changes the state of someone Kit already has, so an unsubscribe stays
    an unsubscribe. `addContact` says so instead of pretending.
  - A total is only returned with `include_total_count=true`; without it a count reads as the one row returned.
  - A draft is a broadcast with `send_at: null`. `subscriber_filter` addresses a tag or a saved segment.
  - Kit's own rate fields have been read as a fraction in one place and a percentage in another, so rates are
    worked out from counts, as fractions (0.46 is 46%), the same unit the Mailchimp adapter uses.
  - A stopped send (Kit's `aborted`) is reported as sent, never as a draft: editing or rescheduling it could mail some
    people twice.
  - The gateway answers 502/503/504 now and then and 429 past 120 calls a minute; both are retried up to three times.
  - There is no bulk API for a key, and a Worker may make only so many calls per request, so `importContacts` is off
    (`capabilities.import` is false) and the hub hides it. Add people one at a time, or in small batches from the host.
  - Kit has no send-test or send-checklist API, so neither is offered.
*/
import { HubError } from '../provider.js';

const BASE = 'https://api.kit.com/v4';
const APP = 'https://app.kit.com';
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const ID = /^\d{1,15}$/;

const TO_HUB = { active: 'subscribed', cancelled: 'unsubscribed', complained: 'unsubscribed', bounced: 'cleaned', inactive: 'pending' };
const TO_KIT = { subscribed: 'active', unsubscribed: 'cancelled', cleaned: 'bounced', pending: 'inactive' };
const STATUS = { draft: 'save', scheduled: 'schedule', sending: 'sending', completed: 'sent', aborted: 'sent' };

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const frac = (n, d) => (Number.isFinite(n) && Number.isFinite(d) && d > 0 ? Math.round((n / d) * 10000) / 10000 : null);
const day = (offset, now) => new Date(now - offset * 86400000).toISOString().slice(0, 10);

/* Whatever Kit or the network threw, as one calm sentence. */
export function explain(e) {
  if (e instanceof HubError) return e;
  if (e?.code === 401 || e?.status === 'no-key') return new HubError('Kit did not accept the connection. The key may have been changed or turned off.', 502);
  if (e?.code === 403 || e?.code === 400 || e?.code === 422) return new HubError('Kit would not do that.', 409);
  if (e?.code === 404) return new HubError('Kit could not find that. It may have been deleted there.', 404);
  if (e?.code === 429) return new HubError('Kit is busy. Try again in a minute.', 503);
  return new HubError('Kit did not answer just now. Try again in a minute.', 502);
}

export function createKitProvider({ apiKey, fetch: inject = null, sleep = null, appUrl = APP, statsFor = 12, fields: fieldKeys = {} } = {}) {
  const key = String(apiKey || '').trim();
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function kit(path, { method = 'GET', body } = {}) {
    if (!key) { const e = new Error('kit key not set'); e.status = 'no-key'; throw e; }
    const send = () => (inject || globalThis.fetch)(`${BASE}${path}`, {
      method,
      headers: { 'X-Kit-Api-Key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let res = await send();
    for (let attempt = 1; [429, 502, 503, 504].includes(res.status) && attempt <= 3; attempt++) {
      const asked = Number(res.headers?.get?.('retry-after'));
      await wait(Math.min(20000, (Number.isFinite(asked) && asked > 0 ? asked : 5 * attempt) * 1000));
      res = await send();
    }
    if (!res.ok) {
      // Status and path only: an error body can quote the request back, and a quoted request contains an address.
      const e = new Error(`kit ${path.split('?')[0]} -> ${res.status}`);
      e.code = res.status;
      throw e;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw explain(e); } };
  const id = (v, what = 'email') => { if (!ID.test(String(v))) throw new HubError(`That is not a ${what} we know.`, 404); return String(v); };
  const email = (v) => { const a = String(v || '').trim().toLowerCase(); if (!EMAIL.test(a)) throw new HubError('That does not look like an email address.'); return a; };

  const filter = ({ tagId, segmentId } = {}) => (segmentId ? [{ all: [{ type: 'segment', ids: [Number(id(segmentId, 'segment'))] }] }]
    : tagId ? [{ all: [{ type: 'tag', ids: [Number(id(tagId, 'tag'))] }] }] : []);

  function shape(b, stats = null) {
    const f = Array.isArray(b?.subscriber_filter) ? b.subscriber_filter : [];
    const aimed = f.some((x) => Object.values(x || {}).some((g) => Array.isArray(g) && g.length));
    const recipients = stats?.recipients ?? null;
    return {
      id: String(b.id), status: STATUS[String(b.status || '').toLowerCase()] || 'save',
      subject: b.subject || '', title: b.description || '', preview: b.preview_text || '',
      audience: 'Kit', segment: aimed ? (JSON.stringify(f).includes('"segment"') ? 'A segment' : 'A tag') : '',
      recipients, created: b.created_at || null, when: b.send_at || b.published_at || null, sent: recipients,
      openRate: stats?.openRate ?? null, clickRate: stats?.clickRate ?? null,
      stats: { opened: stats?.opened ?? null, clicked: stats?.clicked ?? null },
      archiveUrl: b.public_url || null, editUrl: (STATUS[String(b.status || '').toLowerCase()] || 'save') === 'save' ? `${appUrl}/campaigns/${b.id}/draft` : `${appUrl}/campaigns`
    };
  }

  /* Rates from counts, as fractions. */
  const statsOf = (raw) => {
    const s = raw?.broadcast?.stats || raw?.stats || {};
    const recipients = num(s.recipients), opened = num(s.emails_opened ?? s.opens), clicked = num(s.total_clicks ?? s.clicks);
    return { recipients, opened, clicked, unsubscribes: num(s.unsubscribes), openRate: opened != null ? frac(opened, recipients) : null, clickRate: clicked != null ? frac(clicked, recipients) : null };
  };

  const contactOf = (s, tags = []) => ({
    id: String(s.id), email: s.email_address || '', first: s.first_name || '', last: s.fields?.last_name || '', state: TO_HUB[s.state] || 'pending',
    created: s.created_at || null, tags, source: s.fields?.source || null
  });

  /* Tags are made by name, once (Kit answers an existing name with the same id), so "add this tag" never duplicates. */
  const tagIds = new Map();
  async function tagByName(name) {
    const clean = String(name || '').trim().slice(0, 100);
    if (!clean) throw new HubError('Choose a tag.');
    if (tagIds.has(clean)) return tagIds.get(clean);
    const d = await kit('/tags', { method: 'POST', body: { name: clean } });
    const t = { id: String(d?.tag?.id), name: clean };
    tagIds.set(clean, t);
    return t;
  }
  const total = async (status) => (await kit(`/subscribers?status=${status}&per_page=1&include_total_count=true`).catch(() => null))?.pagination?.total_count ?? null;

  return {
    label: 'Kit',
    mergeTags: { address: '{{ address }}', unsubscribe: '{{ unsubscribe_url }}', email: '{{ subscriber.email_address }}' },
    capabilities: { import: false, checklist: false, test: false, layouts: true, templateChange: true },
    connected: () => Boolean(key),
    appUrl: (path = '/') => `${appUrl}${path === '/' ? '' : path}`,
    editUrl: (c) => c.editUrl,

    listCampaigns: guard(async () => {
      const out = [];
      let after = null;
      for (let page = 0; page < 3; page++) {
        const d = await kit(`/broadcasts?per_page=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        out.push(...(d?.broadcasts || []));
        if (!d?.pagination?.has_next_page || !d?.pagination?.end_cursor) break;
        after = d.pagination.end_cursor;
      }
      out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      // A report is one more call each, and a Worker may make only so many per request: the newest few sent ones.
      let budget = statsFor;
      const campaigns = [];
      for (const b of out) {
        let st = null;
        if ((b.status === 'completed' || b.status === 'sending') && budget > 0) { budget -= 1; st = statsOf(await kit(`/broadcasts/${id(b.id)}/stats`).catch(() => null)); }
        campaigns.push(shape(b, st));
      }
      return { total: campaigns.length, campaigns };
    }),
    getCampaign: guard(async (cid) => {
      const b = (await kit(`/broadcasts/${id(cid)}`))?.broadcast || {};
      const st = b.status === 'completed' || b.status === 'sending' ? statsOf(await kit(`/broadcasts/${id(cid)}/stats`).catch(() => null)) : null;
      return shape(b, st);
    }),
    campaignContent: guard(async (cid) => { const b = (await kit(`/broadcasts/${id(cid)}`))?.broadcast; return { html: b?.content || '', text: '', templateId: b?.email_template?.id != null ? String(b.email_template.id) : null, template: b?.email_template?.name || null }; }),
    campaignReport: guard(async (cid) => {
      const s = statsOf(await kit(`/broadcasts/${id(cid)}/stats`));
      return { recipients: s.recipients, opened: s.opened, openRate: s.openRate, clicked: s.clicked, clickRate: s.clickRate, unsubscribed: s.unsubscribes, bounced: null };
    }),
    createCampaign: guard(async ({ subject, previewText, title, html, to, templateId }) => {
      const d = await kit('/broadcasts', { method: 'POST', body: { subject, preview_text: previewText || '', description: title || subject, content: html || '', public: false, send_at: null, subscriber_filter: filter(to), ...(templateId ? { email_template_id: Number(templateId) || templateId } : {}) } });
      return shape(d?.broadcast || {});
    }),
    updateCampaign: guard(async (cid, f) => {
      const body = {};
      if (f.subject !== undefined) body.subject = f.subject;
      if (f.previewText !== undefined) body.preview_text = f.previewText;
      if (f.title !== undefined) body.description = f.title;
      if (f.html !== undefined) body.content = f.html;
      if (f.templateId !== undefined) body.email_template_id = Number(f.templateId) || f.templateId;
      return shape((await kit(`/broadcasts/${id(cid)}`, { method: 'PUT', body }))?.broadcast || {});
    }),
    deleteCampaign: guard(async (cid) => { await kit(`/broadcasts/${id(cid)}`, { method: 'DELETE' }); return {}; }),
    duplicateCampaign: guard(async (cid) => {
      const b = (await kit(`/broadcasts/${id(cid)}`))?.broadcast || {};
      const made = await kit('/broadcasts', { method: 'POST', body: {
        subject: b.subject || '', preview_text: b.preview_text || '', description: `${b.description || b.subject || 'Copy'} (copy)`.slice(0, 200),
        content: b.content || '', public: false, send_at: null, subscriber_filter: Array.isArray(b.subscriber_filter) ? b.subscriber_filter : [],
        // The copy keeps the design: without this Kit would send it in the account's default template, not the original's.
        ...(b.email_template?.id ? { email_template_id: b.email_template.id } : {})
      } });
      return shape(made?.broadcast || {});
    }),
    schedule: guard(async (cid, iso) => { await kit(`/broadcasts/${id(cid)}`, { method: 'PUT', body: { send_at: iso } }); return {}; }),
    unschedule: guard(async (cid) => { await kit(`/broadcasts/${id(cid)}`, { method: 'PUT', body: { send_at: null } }); return {}; }),

    audience: guard(async () => {
      const [tags, segs, active] = await Promise.all([kit('/tags?include=subscriber_count'), kit('/segments').catch(() => ({})), total('active')]);
      const by = (a, b) => a.name.localeCompare(b.name);
      return {
        list: 'Kit', subscribers: active,
        tags: (tags?.tags || []).map((t) => ({ id: String(t.id), name: t.name, count: t.subscriber_count ?? null })).sort(by),
        segments: (segs?.segments || []).map((s) => ({ id: String(s.id), name: s.name, count: null })).sort(by)
      };
    }),
    counts: guard(async () => {
      const [subscribed, unsubscribed, cleaned, pending] = await Promise.all(['active', 'cancelled', 'bounced', 'inactive'].map(total));
      return { subscribed, unsubscribed, cleaned, pending };
    }),
    growth: guard(async (days, now = Date.now()) => {
      const s = (await kit(`/account/growth_stats?starting=${day(days, now)}&ending=${day(0, now)}`))?.stats || {};
      const added = num(s.new_subscribers) ?? 0, unsubscribed = num(s.cancellations) ?? 0;
      return { added, unsubscribed, net: num(s.net_new_subscribers) ?? added - unsubscribed };
    }),

    listContacts: guard(async ({ status = 'subscribed', tag, email: q, after } = {}) => {
      if (q) {
        const a = String(q).trim().toLowerCase();
        if (!EMAIL.test(a)) throw new HubError('That does not look like a full email address.');
        const d = await kit(`/subscribers?email_address=${encodeURIComponent(a)}&status=all`);
        const rows = (d?.subscribers || []).map((s) => contactOf(s));
        return { contacts: rows, total: rows.length, next: null, search: true };
      }
      if (!TO_KIT[status]) throw new HubError('That is not a kind of contact.');
      const cursor = after ? `&after=${encodeURIComponent(String(after))}` : '';
      const path = tag
        ? `/tags/${id(tag, 'tag')}/subscribers?status=${TO_KIT[status]}&per_page=25&include_total_count=true${cursor}`
        : `/subscribers?status=${TO_KIT[status]}&per_page=25&include_total_count=true&sort_field=created_at&sort_order=desc${cursor}`;
      let d;
      try { d = await kit(path); } catch (e) {
        // `sort_field=created_at` is not a documented sort field; if Kit ever refuses it, fall back to its own order.
        if (!/sort_order=desc/.test(path) || ![400, 422].includes(e.code)) throw e;
        d = await kit(path.replace('&sort_field=created_at&sort_order=desc', ''));
      }
      const rows = (d?.subscribers || []).map((s) => contactOf(s));
      return { contacts: rows, total: d?.pagination?.total_count ?? null, next: d?.pagination?.has_next_page ? d.pagination.end_cursor || null : null };
    }),
    contact: guard(async (cid) => {
      const [s, t] = await Promise.all([kit(`/subscribers/${id(cid, 'contact')}`), kit(`/subscribers/${cid}/tags`).catch(() => null)]);
      const sub = s?.subscriber || {};
      // `fields` names the custom fields a host keeps a person's original signup date and source in (e.g. after moving lists);
      // Kit stamps everyone with the day they were IMPORTED, so that field is the only record of when they really joined.
      const f = sub.fields || {};
      return { ...contactOf(sub, (t?.tags || []).map((x) => ({ id: String(x.id), name: x.name }))), joined: f[fieldKeys.joined || 'signup_date'] || null, source: f[fieldKeys.source || 'source'] || null };
    }),
    addContact: guard(async ({ email: e, first, tag }) => {
      const a = email(e);
      const d = await kit('/subscribers', { method: 'POST', body: { email_address: a, ...(first ? { first_name: String(first).slice(0, 100) } : {}), state: 'active' } });
      const sub = d?.subscriber || {};
      if (tag) { const t = await tagByName(tag); await kit(`/tags/${t.id}/subscribers`, { method: 'POST', body: { email_address: a } }); }
      return { contact: contactOf(sub), note: sub.state && sub.state !== 'active' ? 'That person had unsubscribed, so they stay unsubscribed.' : '' };
    }),
    tagContact: guard(async (cid, name, active) => {
      const t = await tagByName(name);
      if (active) {
        const s = (await kit(`/subscribers/${id(cid, 'contact')}`))?.subscriber || {};
        await kit(`/tags/${t.id}/subscribers`, { method: 'POST', body: { email_address: email(s.email_address) } });
      } else await kit(`/tags/${t.id}/subscribers/${id(cid, 'contact')}`, { method: 'DELETE' });
      return { ok: true };
    }),
    unsubscribeContact: guard(async (cid) => { await kit(`/subscribers/${id(cid, 'contact')}/unsubscribe`, { method: 'POST' }); return { ok: true }; }),
    createTag: guard(async (name) => { const t = await tagByName(name); return { tag: { id: t.id, name: t.name, count: 0 } }; }),
    listTemplates: guard(async () => {
      const d = await kit('/email_templates');
      return { templates: (d?.email_templates || []).map((t) => ({ id: String(t.id), name: t.name, isDefault: Boolean(t.is_default) })) };
    }),
    fields: guard(async () => {
      const d = await kit('/custom_fields');
      return { fields: (d?.custom_fields || []).map((f) => ({ tag: f.key, name: f.label || f.name, type: 'text', required: false })) };
    }),

    /* For the host's own public unsubscribe route (see ../unsubscribe.js). Only an active or held person is cancelled;
       a bounced or already-cancelled one is left as Kit has them. It says nothing about whether the address was on the
       list, so it cannot be used to look people up. */
    unsubscribeByEmail: guard(async (raw) => {
      const a = String(raw || '').trim().toLowerCase();
      if (!EMAIL.test(a)) return;
      const d = await kit(`/subscribers?email_address=${encodeURIComponent(a)}&status=all`);
      const s = (d?.subscribers || []).find((x) => String(x.email_address || '').toLowerCase() === a);
      if (s && (s.state === 'active' || s.state === 'inactive')) await kit(`/subscribers/${id(s.id, 'contact')}/unsubscribe`, { method: 'POST' });
    })
  };
}
