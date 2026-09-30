/*
  An in-memory email provider (see ../provider.js for the contract). Two jobs: it lets a host build and demo the hub
  with no account and no key, and it is the small reference for what a provider must do. Nothing leaves the process and
  nothing is remembered after it. Like a careful service: adding a person never changes the state of someone who is
  already there, and only a draft or scheduled email can change.

    const provider = createMemoryProvider({ now });   // provider.seed({ contacts, campaigns, tags }) fills it
*/
import { HubError } from '../provider.js';

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

export function createMemoryProvider({ now = () => Date.now() } = {}) {
  let seq = 1;
  const nid = () => String(seq++);
  const contacts = new Map(), tags = new Map(), campaigns = new Map();
  const iso = () => new Date(now()).toISOString();
  const shape = (c) => ({ id: c.id, status: c.status, subject: c.subject, title: c.title, preview: c.preview, audience: 'Memory', segment: c.to?.tagId ? 'A tag' : c.to?.segmentId ? 'A segment' : '',
    recipients: c.sent ?? null, created: c.created, when: c.when || null, sent: c.sent ?? null, openRate: c.openRate ?? null, clickRate: c.clickRate ?? null, stats: { opened: c.opened ?? null, clicked: c.clicked ?? null }, archiveUrl: null, editUrl: null });
  const camp = (id) => { const c = campaigns.get(String(id)); if (!c) throw new HubError('That is not an email we know.', 404); return c; };
  const person = (id) => { const c = contacts.get(String(id)); if (!c) throw new HubError('That is not a contact we know.', 404); return c; };
  const byEmail = (e) => [...contacts.values()].find((c) => c.email === String(e || '').trim().toLowerCase());
  const outC = (c) => ({ id: c.id, email: c.email, first: c.first, last: '', state: c.state, created: c.created, tags: [...c.tags].map((t) => ({ id: t, name: tags.get(t)?.name })), source: null });

  const p = {
    label: 'Memory',
    mergeTags: { address: '{{ address }}', unsubscribe: '{{ unsubscribe_url }}', email: '{{ email }}' },
    capabilities: { layouts: true },
    connected: () => true,
    appUrl: () => 'https://memory.invalid/',
    editUrl: () => null,

    seed({ contacts: cs = [], campaigns: bs = [], tags: ts = [] } = {}) {
      for (const t of ts) { const id = nid(); tags.set(id, { id, name: t }); }
      for (const c of cs) { const id = nid(); contacts.set(id, { id, email: c.email.toLowerCase(), first: c.first || '', state: c.state || 'subscribed', created: c.created || iso(), tags: new Set() }); }
      for (const b of bs) { const id = nid(); campaigns.set(id, { id, status: 'save', subject: '', title: '', preview: '', html: '', created: iso(), ...b }); }
      return p;
    },
    /* Pretend the service sent it: only a draft or scheduled email can go, and then it has figures. */
    send(id, { opened = 0, clicked = 0 } = {}) {
      const c = camp(id), n = [...contacts.values()].filter((x) => x.state === 'subscribed').length;
      Object.assign(c, { status: 'sent', when: iso(), sent: n, opened, clicked, openRate: n ? opened / n : null, clickRate: n ? clicked / n : null });
    },

    listCampaigns: async () => ({ total: campaigns.size, campaigns: [...campaigns.values()].sort((a, b) => String(b.created).localeCompare(String(a.created))).map(shape) }),
    getCampaign: async (id) => shape(camp(id)),
    campaignContent: async (id) => ({ html: camp(id).html || '', text: '' }),
    createCampaign: async ({ subject, previewText, title, html, to }) => { const id = nid(); const c = { id, status: 'save', subject, preview: previewText || '', title: title || subject, html: html || '', to: to || {}, created: iso() }; campaigns.set(id, c); return shape(c); },
    updateCampaign: async (id, f) => { const c = camp(id); if (f.subject !== undefined) c.subject = f.subject; if (f.previewText !== undefined) c.preview = f.previewText; if (f.title !== undefined) c.title = f.title; if (f.html !== undefined) c.html = f.html; return shape(c); },
    deleteCampaign: async (id) => { camp(id); campaigns.delete(String(id)); return {}; },
    duplicateCampaign: async (id) => { const s = camp(id); const n = nid(); const c = { ...s, id: n, status: 'save', when: null, sent: null, openRate: null, clickRate: null, created: iso(), title: `${s.title} (copy)` }; campaigns.set(n, c); return shape(c); },
    schedule: async (id, at) => { const c = camp(id); c.status = 'schedule'; c.when = at; return {}; },
    unschedule: async (id) => { const c = camp(id); c.status = 'save'; c.when = null; return {}; },
    campaignReport: async (id) => { const c = camp(id); return { recipients: c.sent ?? null, opened: c.opened ?? null, openRate: c.openRate ?? null, clicked: c.clicked ?? null, clickRate: c.clickRate ?? null, unsubscribed: null, bounced: null }; },

    audience: async () => ({ list: 'Memory', subscribers: [...contacts.values()].filter((c) => c.state === 'subscribed').length,
      tags: [...tags.values()].map((t) => ({ id: t.id, name: t.name, count: [...contacts.values()].filter((c) => c.tags.has(t.id)).length })), segments: [] }),
    counts: async () => { const o = { subscribed: 0, unsubscribed: 0, cleaned: 0, pending: 0 }; for (const c of contacts.values()) if (c.state in o) o[c.state] += 1; return o; },
    growth: async (days, at = now()) => { const from = at - days * 86400000; const added = [...contacts.values()].filter((c) => Date.parse(c.created) >= from && c.state === 'subscribed').length; return { added, unsubscribed: 0, net: added }; },

    listContacts: async ({ status = 'subscribed', tag, email } = {}) => {
      let rows = [...contacts.values()];
      if (email) rows = rows.filter((c) => c.email === String(email).trim().toLowerCase());
      else rows = rows.filter((c) => c.state === status && (!tag || c.tags.has(String(tag))));
      return { contacts: rows.map(outC), total: rows.length, next: null };
    },
    contact: async (id) => outC(person(id)),
    addContact: async ({ email, first, tag }) => {
      if (!EMAIL.test(String(email || ''))) throw new HubError('That does not look like an email address.');
      let c = byEmail(email), note = '';
      if (!c) { const id = nid(); c = { id, email: email.toLowerCase(), first: first || '', state: 'subscribed', created: iso(), tags: new Set() }; contacts.set(id, c); }
      else if (c.state !== 'subscribed') note = 'That person had unsubscribed, so they stay unsubscribed.';
      if (tag) { const t = await p.createTag(tag); c.tags.add(t.tag.id); }
      return { contact: outC(c), note };
    },
    tagContact: async (id, name, active) => { const c = person(id); const t = (await p.createTag(name)).tag; if (active) c.tags.add(t.id); else c.tags.delete(t.id); return { ok: true }; },
    unsubscribeContact: async (id) => { person(id).state = 'unsubscribed'; return { ok: true }; },
    unsubscribeByEmail: async (e) => { const c = byEmail(e); if (c && (c.state === 'subscribed' || c.state === 'pending')) c.state = 'unsubscribed'; },
    createTag: async (name) => { const n = String(name || '').trim(); const have = [...tags.values()].find((t) => t.name === n); if (have) return { tag: { ...have, count: 0 } }; const id = nid(); tags.set(id, { id, name: n }); return { tag: { id, name: n, count: 0 } }; },
    fields: async () => ({ fields: [] }),
  };
  return p;
}
