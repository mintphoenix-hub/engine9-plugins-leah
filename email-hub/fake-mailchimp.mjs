/*
  A stand-in for Mailchimp's API, for tests and for the local admin preview. It replaces global fetch, answers
  the handful of calls mailchimp.js makes, and follows the rules that matter: only a draft can be changed,
  scheduling needs a future quarter-hour, and a campaign is "ready" only when it has a subject and content.
  Nothing here reaches the network.
*/
import { createHash } from 'node:crypto';
const md5 = (e) => createHash('md5').update(String(e).toLowerCase()).digest('hex');

export function fakeMailchimp({ now = () => Date.now(), campaigns: seed = [] } = {}) {
  const calls = [];
  const fails = [];
  const state = {
    list: { id: 'LIST1', name: 'Example Studio', members: 214, from_name: 'Ada Example', from_email: 'hello@example.org' },
    tags: [{ id: 11, name: 'Workshops', member_count: 40 }, { id: 12, name: 'Members', member_count: 97 }],
    segments: [{ id: 21, name: 'New this month', member_count: 9 }],
    campaigns: new Map(),
    members: [],
    seq: 100
  };
  const person = (email, over = {}) => ({ id: md5(email), email_address: email, status: 'subscribed', merge_fields: { FNAME: '', LNAME: '' }, timestamp_opt: new Date(now()).toISOString(), last_changed: new Date(now()).toISOString(), tags: [], ...over });
  const put = (c) => { state.campaigns.set(c.id, c); return c; };
  for (const c of seed) put(c);
  const newCampaign = (b, extra = {}) => put({
    id: 'c' + (++state.seq), web_id: state.seq * 7, type: 'regular', status: 'save', create_time: new Date(now()).toISOString(), send_time: '', emails_sent: 0, archive_url: '',
    settings: { subject_line: '', title: '', preview_text: '', from_name: '', reply_to: '', ...(b.settings || {}) },
    recipients: { list_id: state.list.id, list_name: state.list.name, recipient_count: state.list.members, segment_text: '', segment_opts: b.recipients?.segment_opts || null },
    report_summary: {}, html: '', ...extra
  });
  const out = (c) => ({ ...c, html: undefined });
  const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });

  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (!/\.api\.mailchimp\.com$/.test(u.hostname)) return original(url, opts);
    const path = u.pathname.replace(/^\/3\.0/, '');
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, path, query: Object.fromEntries(u.searchParams), body, auth: opts.headers?.Authorization });
    const f = fails.findIndex((x) => x.method === method && x.re.test(path));
    if (f >= 0) { const x = fails.splice(f, 1)[0]; return reply(x.status, { title: 'Refused', status: x.status, detail: x.detail }); }

    let m;
    if (method === 'GET' && (m = /^\/lists\/([^/]+)$/.exec(path))) {
      return reply(200, { name: state.list.name, campaign_defaults: { from_name: state.list.from_name, from_email: state.list.from_email }, stats: { member_count: state.list.members } });
    }
    if (method === 'GET' && /^\/lists\/[^/]+\/segments$/.test(path)) {
      const rows = u.searchParams.get('type') === 'saved' ? state.segments : state.tags;
      return reply(200, { segments: rows });
    }
    if (method === 'GET' && path === '/campaigns') return reply(200, { campaigns: [...state.campaigns.values()].filter((c) => c.type === 'regular').map(out), total_items: state.campaigns.size });
    if (method === 'POST' && path === '/campaigns') return reply(200, out(newCampaign(body)));
    if ((m = /^\/campaigns\/([^/]+)$/.exec(path))) {
      const c = state.campaigns.get(m[1]);
      if (!c) return reply(404, { detail: 'The requested resource could not be found.' });
      if (method === 'GET') return reply(200, out(c));
      if (c.status !== 'save' && c.status !== 'paused') return reply(400, { detail: 'You can only edit or delete campaigns that have not been sent.' });
      if (method === 'PATCH') { Object.assign(c.settings, body.settings || {}); return reply(200, out(c)); }
      if (method === 'DELETE') { state.campaigns.delete(c.id); return reply(204); }
    }
    if ((m = /^\/campaigns\/([^/]+)\/content$/.exec(path))) {
      const c = state.campaigns.get(m[1]); if (!c) return reply(404, { detail: 'not found' });
      if (method === 'PUT') { c.html = body.html; return reply(200, {}); }
      if (method === 'GET') return reply(200, { html: c.html, plain_text: c.html.replace(/<[^>]+>/g, ' ') });
    }
    if (method === 'GET' && (m = /^\/campaigns\/([^/]+)\/send-checklist$/.exec(path))) {
      const c = state.campaigns.get(m[1]); if (!c) return reply(404, { detail: 'not found' });
      const items = [];
      if (!c.settings.subject_line) items.push({ type: 'error', heading: 'Subject line', details: 'Add a subject line.' });
      if (!c.html) items.push({ type: 'error', heading: 'Content', details: 'Your campaign has no content.' });
      return reply(200, { is_ready: !items.length, items });
    }
    if (method === 'POST' && (m = /^\/campaigns\/([^/]+)\/actions\/(replicate|schedule|unschedule|test)$/.exec(path))) {
      const c = state.campaigns.get(m[1]); if (!c) return reply(404, { detail: 'not found' });
      if (m[2] === 'replicate') return reply(200, out(newCampaign(c, { html: c.html, settings: { ...c.settings, title: c.settings.title + ' (copy)' } })));
      if (m[2] === 'test') { return reply(204); }
      if (m[2] === 'schedule') {
        const t = Date.parse(body.schedule_time);
        if (c.status !== 'save') return reply(400, { detail: 'Only drafts can be scheduled.' });
        if (t % 900000 !== 0) return reply(400, { detail: 'Campaigns may only be scheduled to send on the quarter-hour.' });
        if (t <= now()) return reply(400, { detail: 'Schedule time must be in the future.' });
        c.status = 'schedule'; c.send_time = new Date(t).toISOString(); return reply(204);
      }
      if (m[2] === 'unschedule') { if (c.status !== 'schedule') return reply(400, { detail: 'Campaign is not scheduled.' }); c.status = 'save'; c.send_time = ''; return reply(204); }
    }
    /* ---- contacts ---- */
    if ((m = /^\/lists\/[^/]+\/members$/.exec(path)) && method === 'GET') {
      const st = u.searchParams.get('status'), count = Number(u.searchParams.get('count') || 10), off = Number(u.searchParams.get('offset') || 0);
      const sinceOpt = u.searchParams.get('since_timestamp_opt'), sinceCh = u.searchParams.get('since_last_changed');
      let rows = state.members.filter((x) => (!st || x.status === st) && (!sinceOpt || x.timestamp_opt >= sinceOpt) && (!sinceCh || x.last_changed >= sinceCh));
      return reply(200, { members: rows.slice(off, off + count), total_items: rows.length });
    }
    if ((m = /^\/lists\/[^/]+\/members\/([^/]+)$/.exec(path))) {
      const key = decodeURIComponent(m[1]);
      let p = state.members.find((x) => x.id === key || x.id === md5(key));
      if (method === 'GET') return p ? reply(200, p) : reply(404, { detail: 'The requested resource could not be found.' });
      if (method === 'PUT') {
        if (!p) { p = person(body.email_address, { status: body.status_if_new || 'subscribed' }); state.members.push(p); }
        if (body.merge_fields) Object.assign(p.merge_fields, body.merge_fields);
        return reply(200, p);
      }
      if (method === 'PATCH' && p) { Object.assign(p, { status: body.status ?? p.status, last_changed: new Date(now()).toISOString() }); return reply(200, p); }
      return reply(404, { detail: 'not found' });
    }
    if ((m = /^\/lists\/[^/]+\/members\/([^/]+)\/tags$/.exec(path)) && method === 'POST') {
      const key = decodeURIComponent(m[1]); const p = state.members.find((x) => x.id === key || x.id === md5(key));
      if (!p) return reply(404, { detail: 'not found' });
      for (const t of body.tags) {
        let tag = state.tags.find((x) => x.name === t.name); if (!tag) { tag = { id: ++state.seq, name: t.name, member_count: 0 }; state.tags.push(tag); }
        const has = p.tags.some((x) => x.id === tag.id);
        if (t.status === 'active' && !has) p.tags.push({ id: tag.id, name: tag.name });
        if (t.status === 'inactive') p.tags = p.tags.filter((x) => x.id !== tag.id);
      }
      return reply(204);
    }
    if ((m = /^\/lists\/[^/]+\/segments\/(\d+)\/members$/.exec(path)) && method === 'GET') {
      const rows = state.members.filter((x) => x.tags.some((t) => t.id === Number(m[1])));
      return reply(200, { members: rows, total_items: rows.length });
    }
    if (method === 'POST' && /^\/lists\/[^/]+\/segments$/.test(path)) { const t = { id: ++state.seq, name: body.name, member_count: 0 }; state.tags.push(t); return reply(200, t); }
    if (method === 'GET' && /^\/lists\/[^/]+\/merge-fields$/.test(path)) return reply(200, { merge_fields: [{ tag: 'EMAIL', name: 'Email Address', type: 'email', required: true }, { tag: 'FNAME', name: 'First Name', type: 'text', required: false }] });
    if (method === 'GET' && (m = /^\/reports\/([^/]+)$/.exec(path))) { const c = state.campaigns.get(m[1]); if (!c) return reply(404, { detail: 'not found' }); return reply(200, { emails_sent: c.emails_sent, opens: { unique_opens: 83, open_rate: 0.46 }, clicks: { unique_subscriber_clicks: 11, click_rate: 0.06 }, unsubscribed: 2, bounces: { hard_bounces: 1, soft_bounces: 0 } }); }
    if (method === 'POST' && path === '/batches') { state.batches = (state.batches || 0) + 1; for (const op of body.operations) { if (op.method === 'PUT') { const b = JSON.parse(op.body); if (!state.members.some((x) => x.email_address === b.email_address)) state.members.push(person(b.email_address, { status: b.status_if_new })); } } return reply(200, { id: 'batch' + state.batches, status: 'pending' }); }
    if (method === 'GET' && (m = /^\/batches\/([^/]+)$/.exec(path))) return reply(200, { status: 'finished', total_operations: 2, finished_operations: 2, errored_operations: 0 });
    return reply(404, { detail: `fake mailchimp has no ${method} ${path}` });
  };
  return {
    state, calls,
    failNext: (method, re, status, detail = '') => fails.push({ method, re, status, detail }),
    restore: () => { globalThis.fetch = original; },
    add: put, person,
    addMember: (email, over) => { const p = person(email, over); state.members.push(p); return p; }
  };
}

export const sentCampaign = (over = {}) => ({
  id: 'sent1', web_id: 1, type: 'regular', status: 'sent', create_time: '2026-08-01T00:00:00Z', send_time: '2026-08-02T01:00:00Z', emails_sent: 180, archive_url: 'https://mailchi.mp/x',
  settings: { subject_line: 'Spring gathering', title: 'Spring gathering', preview_text: 'Save the date' },
  recipients: { list_id: 'LIST1', list_name: 'Example Studio', recipient_count: 180, segment_text: '' },
  report_summary: { open_rate: 0.46, click_rate: 0.06, unique_opens: 83, subscriber_clicks: 11 }, html: '<p>hi</p>', ...over
});
