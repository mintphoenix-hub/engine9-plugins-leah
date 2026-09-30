/*
  A Mailchimp provider for the email hub (see ../provider.js for the contract).

    const provider = createMailchimpProvider({ apiKey: env.MAILCHIMP_API_KEY, listId: env.MAILCHIMP_LIST_ID,
                                                fromName: 'Sender name', replyTo: 'reply@example.org' });

  The key is the host's secret; it is used for the Authorization header and never returned or logged. `fetch` is
  looked up at call time (or injected), so a test can stand in for the network. Mailchimp's data centre is the
  suffix of the key (`...-us17`).

  Members are addressed by Mailchimp's member id (the MD5 of the lower-cased address), never by the address, so an
  address does not end up in a URL or a log. Only a draft can change or go: the hub checks that before it asks.
*/
import { HubError } from '../provider.js';

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const STATES = ['subscribed', 'unsubscribed', 'cleaned', 'pending'];

export const mailchimpDc = (key) => { const m = /-([a-z]+\d+)$/.exec(String(key || '').trim()); return m ? m[1] : null; };

/* Whatever Mailchimp or the network threw, as one calm sentence. */
export function explain(e) {
  if (e instanceof HubError) return e;
  if (e?.code === 401) return new HubError('Mailchimp did not accept the connection. The key may have been changed or turned off.', 502);
  if (e?.code === 403 || e?.code === 400 || e?.code === 422) return new HubError(e.detail ? `Mailchimp says: ${e.detail}` : 'Mailchimp would not do that.', 409);
  if (e?.code === 404) return new HubError('Mailchimp could not find that. It may have been deleted there.', 404);
  if (e?.code === 429) return new HubError('Mailchimp is busy. Try again in a minute.', 503);
  return new HubError('Mailchimp did not answer just now. Try again in a minute.', 502);
}

export function createMailchimpProvider({ apiKey, listId, fromName = '', replyTo = '', apiUser = 'hub', fetch: inject = null } = {}) {
  const key = String(apiKey || '').trim(), list = String(listId || '').trim(), dc = mailchimpDc(key);
  const connected = () => Boolean(key && dc && list);

  async function mc(path, { method = 'GET', body } = {}) {
    const res = await (inject || globalThis.fetch)(`https://${dc}.api.mailchimp.com/3.0${path}`, {
      method,
      headers: { Authorization: `Basic ${btoa(`${apiUser}:${key}`)}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!res.ok) {
      const e = new Error(`mailchimp ${path.split('?')[0]} -> ${res.status}`);
      e.code = res.status;
      // A refused key is reported by status alone: that body can quote the request. Other refusals carry a plain
      // reason worth showing, with anything key-shaped removed.
      if (res.status !== 401) {
        try { const j = await res.json(); e.detail = String(j?.detail || j?.title || '').replace(/[0-9a-f]{32}-[a-z]+\d+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 300); } catch { /* no reason given */ }
      }
      throw e;
    }
    if (res.status === 204) return {};
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  const cid = (id) => { if (!/^[a-z0-9]+$/i.test(String(id))) throw new HubError('That is not an email we know.', 404); return String(id); };
  const hid = (id) => { if (!/^[a-f0-9]{32}$/.test(String(id))) throw new HubError('That is not a contact we know.', 404); return String(id); };
  const md5 = async (email) => {
    try { const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(email)); return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
    catch { return encodeURIComponent(email); }
  };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw explain(e); } };

  const FIELDS = ['id', 'web_id', 'type', 'status', 'create_time', 'send_time', 'emails_sent', 'archive_url', 'settings.subject_line', 'settings.title', 'settings.preview_text',
    'recipients.list_name', 'recipients.recipient_count', 'recipients.segment_text', 'report_summary.open_rate', 'report_summary.click_rate', 'report_summary.unique_opens', 'report_summary.subscriber_clicks']
    .map((f) => `campaigns.${f}`).join(',');

  const shape = (c) => {
    const r = c.report_summary || {};
    return {
      id: c.id, status: c.status, subject: c.settings?.subject_line || '', title: c.settings?.title || '', preview: c.settings?.preview_text || '',
      audience: c.recipients?.list_name || '', segment: c.recipients?.segment_text ? String(c.recipients.segment_text).replace(/<[^>]+>/g, '').trim() : '',
      recipients: c.recipients?.recipient_count ?? null, created: c.create_time || null, when: c.send_time || null, sent: c.emails_sent ?? null,
      openRate: typeof r.open_rate === 'number' ? r.open_rate : null, clickRate: typeof r.click_rate === 'number' ? r.click_rate : null,
      stats: { opened: r.unique_opens ?? null, clicked: r.subscriber_clicks ?? null }, archiveUrl: c.archive_url || null,
      editUrl: c.web_id ? `https://${dc}.admin.mailchimp.com/campaigns/show/?id=${c.web_id}` : null
    };
  };
  const recipients = ({ tagId, segmentId } = {}) => {
    const r = { list_id: list };
    if (segmentId) r.segment_opts = { saved_segment_id: Number(segmentId) };
    else if (tagId) r.segment_opts = { match: 'all', conditions: [{ condition_type: 'StaticSegment', field: 'static_segment', op: 'static_is', value: Number(tagId) }] };
    return r;
  };
  const member = (m) => ({ id: m.id, email: m.email_address, first: m.merge_fields?.FNAME || '', last: m.merge_fields?.LNAME || '', state: m.status, created: m.timestamp_opt || m.timestamp_signup || m.last_changed || null, tags: (m.tags || []).map((t) => ({ id: t.id, name: t.name })), source: m.source || '' });
  const total = async (q) => (await mc(`/lists/${list}/members?${q}&count=1&fields=total_items`)).total_items ?? 0;

  return {
    label: 'Mailchimp',
    mergeTags: { address: '*|LIST:ADDRESSLINE|*', unsubscribe: '*|UNSUB|*', email: '*|EMAIL|*' },
    capabilities: {},
    connected,
    appUrl: (path = '/') => (dc ? `https://${dc}.admin.mailchimp.com${path}` : 'https://mailchimp.com/'),
    editUrl: (c) => c.editUrl,
    /* The host's own use (e.g. its analytics page): the same call, plus the list-level rates. */
    mc: guard(mc),

    listCampaigns: guard(async () => {
      const d = await mc(`/campaigns?type=regular&count=200&sort_field=create_time&sort_dir=DESC&fields=${FIELDS},total_items`);
      return { dc, total: d.total_items ?? null, campaigns: (d.campaigns || []).map(shape) };
    }),
    getCampaign: guard(async (id) => shape(await mc(`/campaigns/${cid(id)}`))),
    campaignContent: guard(async (id) => { const d = await mc(`/campaigns/${cid(id)}/content?fields=html,plain_text`); return { html: d.html || '', text: d.plain_text || '' }; }),
    campaignReport: guard(async (id) => {
      const r = await mc(`/reports/${cid(id)}?fields=emails_sent,opens.unique_opens,opens.open_rate,clicks.unique_subscriber_clicks,clicks.click_rate,unsubscribed,bounces.hard_bounces,bounces.soft_bounces`);
      return { recipients: r.emails_sent ?? null, opened: r.opens?.unique_opens ?? null, openRate: r.opens?.open_rate ?? null, clicked: r.clicks?.unique_subscriber_clicks ?? null, clickRate: r.clicks?.click_rate ?? null, unsubscribed: r.unsubscribed ?? null, bounced: (r.bounces?.hard_bounces || 0) + (r.bounces?.soft_bounces || 0) };
    }),
    createCampaign: guard(async ({ subject, previewText, title, html, to }) => {
      const def = (await mc(`/lists/${list}?fields=campaign_defaults`)).campaign_defaults || {};
      const c = await mc('/campaigns', { method: 'POST', body: { type: 'regular', recipients: recipients(to), settings: { subject_line: subject, preview_text: previewText || '', title: title || subject, from_name: def.from_name || fromName || 'Sender', reply_to: def.from_email || replyTo } } });
      if (html) await mc(`/campaigns/${c.id}/content`, { method: 'PUT', body: { html } });
      return shape(c);
    }),
    updateCampaign: guard(async (id, f) => {
      const settings = {};
      if (f.subject !== undefined) settings.subject_line = f.subject;
      if (f.previewText !== undefined) settings.preview_text = f.previewText;
      if (f.title !== undefined) settings.title = f.title;
      return shape(await mc(`/campaigns/${cid(id)}`, { method: 'PATCH', body: { settings } }));
    }),
    deleteCampaign: guard(async (id) => { await mc(`/campaigns/${cid(id)}`, { method: 'DELETE' }); return {}; }),
    duplicateCampaign: guard(async (id) => shape(await mc(`/campaigns/${cid(id)}/actions/replicate`, { method: 'POST' }))),
    schedule: guard(async (id, iso) => { await mc(`/campaigns/${cid(id)}/actions/schedule`, { method: 'POST', body: { schedule_time: iso } }); return {}; }),
    unschedule: guard(async (id) => { await mc(`/campaigns/${cid(id)}/actions/unschedule`, { method: 'POST' }); return {}; }),
    sendChecklist: guard(async (id) => {
      const d = await mc(`/campaigns/${cid(id)}/send-checklist`);
      const items = (d.items || []).map((i) => ({ type: i.type, heading: i.heading || '', details: String(i.details || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }));
      return { ready: Boolean(d.is_ready), problems: items.filter((i) => i.type === 'error') };
    }),
    sendTest: guard(async (id, emails) => { await mc(`/campaigns/${cid(id)}/actions/test`, { method: 'POST', body: { test_emails: emails, send_type: 'html' } }); return { ok: true, sentTo: emails }; }),

    audience: guard(async () => {
      const [tags, segs, l] = await Promise.all([
        mc(`/lists/${list}/segments?type=static&count=1000&fields=segments.id,segments.name,segments.member_count`),
        mc(`/lists/${list}/segments?type=saved&count=1000&fields=segments.id,segments.name,segments.member_count`),
        mc(`/lists/${list}?fields=name,stats.member_count`)
      ]);
      const s = (t) => ({ id: t.id, name: t.name, count: t.member_count ?? null }), by = (a, b) => a.name.localeCompare(b.name);
      return { list: l.name || '', subscribers: l.stats?.member_count ?? null, tags: (tags.segments || []).map(s).sort(by), segments: (segs.segments || []).map(s).sort(by) };
    }),
    counts: guard(async () => Object.fromEntries(await Promise.all(STATES.map(async (s) => [s, await total(`status=${s}`)])))),
    growth: guard(async (days, now = Date.now()) => {
      const since = encodeURIComponent(new Date(now - days * 86400_000).toISOString());
      const [a, u] = await Promise.all([total(`status=subscribed&since_timestamp_opt=${since}`), total(`status=unsubscribed&since_last_changed=${since}`)]);
      return { added: a, unsubscribed: u, net: a - u };
    }),
    /* List-level engagement and month by month growth, for a host analytics page. */
    stats: guard(async () => {
      const [l, g] = await Promise.all([
        mc(`/lists/${list}?fields=stats.member_count,stats.unsubscribe_count,stats.cleaned_count,stats.open_rate,stats.click_rate,stats.last_sub_date`),
        mc(`/lists/${list}/growth-history?count=6&sort_field=month&sort_dir=DESC&fields=history.month,history.existing,history.imports,history.optins`)
      ]);
      const s = l.stats || {};
      return { subscribers: s.member_count ?? null, unsubscribed: s.unsubscribe_count ?? null, openRate: typeof s.open_rate === 'number' ? s.open_rate / 100 : null, clickRate: typeof s.click_rate === 'number' ? s.click_rate / 100 : null, lastSubscribed: s.last_sub_date || null,
        growth: (g.history || []).map((h) => ({ month: h.month, total: h.existing ?? null, added: (h.imports || 0) + (h.optins || 0) })).reverse() };
    }),

    listContacts: guard(async ({ status = 'subscribed', tag, email, after } = {}) => {
      const count = 25, off = Math.max(0, Math.min(100000, Number(after) || 0));
      if (email) {
        const e = String(email).trim().toLowerCase();
        if (!EMAIL.test(e)) throw new HubError('That does not look like a full email address.');
        try { const m = await mc(`/lists/${list}/members/${await md5(e)}`); return { contacts: [member(m)], total: 1, next: null, search: true }; }
        catch (err) { if (err?.code === 404) return { contacts: [], total: 0, next: null, search: true }; throw err; }
      }
      const f = 'members.id,members.email_address,members.status,members.merge_fields,members.timestamp_opt,members.timestamp_signup,members.last_changed,members.tags,total_items';
      let d;
      if (tag) {
        if (!/^\d{1,12}$/.test(String(tag))) throw new HubError('That is not a tag we know.', 404);
        d = await mc(`/lists/${list}/segments/${tag}/members?count=${count}&offset=${off}&fields=members.id,members.email_address,members.status,members.merge_fields,members.last_changed,total_items`);
      } else {
        if (!STATES.includes(status)) throw new HubError('That is not a kind of contact.');
        d = await mc(`/lists/${list}/members?status=${status}&count=${count}&offset=${off}&sort_field=timestamp_opt&sort_dir=DESC&fields=${f}`);
      }
      const t = d.total_items ?? null, rows = (d.members || []).map(member);
      return { contacts: rows, total: t, next: t != null && off + rows.length < t ? String(off + count) : null, offset: off };
    }),
    contact: guard(async (id) => { const m = await mc(`/lists/${list}/members/${hid(id)}`); return { ...member(m), joined: m.timestamp_opt || m.timestamp_signup || null }; }),
    addContact: guard(async ({ email, first, last, tag }) => {
      const mid = await md5(email), merge = {};
      if (first) merge.FNAME = first; if (last) merge.LNAME = last;
      // status_if_new: someone who unsubscribed keeps that choice; they are never quietly put back.
      const m = await mc(`/lists/${list}/members/${mid}`, { method: 'PUT', body: { email_address: email, status_if_new: 'subscribed', ...(Object.keys(merge).length ? { merge_fields: merge } : {}) } });
      if (tag) await mc(`/lists/${list}/members/${mid}/tags`, { method: 'POST', body: { tags: [{ name: tag, status: 'active' }] } });
      return { contact: member(m), note: m.status === 'unsubscribed' ? 'That person had unsubscribed, so they stay unsubscribed.' : '' };
    }),
    tagContact: guard(async (id, name, active) => { await mc(`/lists/${list}/members/${hid(id)}/tags`, { method: 'POST', body: { tags: [{ name, status: active ? 'active' : 'inactive' }] } }); return { ok: true }; }),
    /* For the host's own public unsubscribe route (see ../unsubscribe.js). Only a subscribed or pending person is
       cancelled; anyone else, and any address Mailchimp does not have, is left alone and reported the same way. */
    unsubscribeByEmail: guard(async (raw) => {
      const a = String(raw || '').trim().toLowerCase();
      if (!EMAIL.test(a)) return;
      const path = `/lists/${list}/members/${await md5(a)}`;
      let m;
      try { m = await mc(`${path}?fields=status`); } catch (err) { if (err?.code === 404) return; throw err; }
      if (m.status === 'subscribed' || m.status === 'pending') await mc(path, { method: 'PATCH', body: { status: 'unsubscribed' } });
    }),
    unsubscribeContact: guard(async (id) => { await mc(`/lists/${list}/members/${hid(id)}`, { method: 'PATCH', body: { status: 'unsubscribed' } }); return { ok: true }; }),
    createTag: guard(async (name) => { const t = await mc(`/lists/${list}/segments`, { method: 'POST', body: { name, static_segment: [] } }); return { tag: { id: t.id, name: t.name, count: 0 } }; }),
    listTemplates: guard(async () => {
      const d = await mc('/templates?type=user&count=100&fields=templates.id,templates.name');
      return { templates: (d.templates || []).map((t) => ({ id: String(t.id), name: t.name, isDefault: false })) };
    }),
    fields: guard(async () => {
      const d = await mc(`/lists/${list}/merge-fields?count=100&fields=merge_fields.tag,merge_fields.name,merge_fields.type,merge_fields.required`);
      return { fields: (d.merge_fields || []).map((f) => ({ tag: f.tag, name: f.name, type: f.type, required: Boolean(f.required) })) };
    }),
    /* One Mailchimp batch: PUT the member, then POST the tag. A Worker may only make so many requests per call, so
       the batch runs on Mailchimp's side. New people are pending (Mailchimp asks them to confirm) unless `agreed`. */
    importContacts: guard(async ({ people, tag, agreed }) => {
      const ops = [];
      for (const p of people) {
        const mid = await md5(p.email), merge = {};
        if (p.first) merge.FNAME = p.first; if (p.last) merge.LNAME = p.last;
        ops.push({ method: 'PUT', path: `/lists/${list}/members/${mid}`, body: JSON.stringify({ email_address: p.email, status_if_new: agreed ? 'subscribed' : 'pending', ...(Object.keys(merge).length ? { merge_fields: merge } : {}) }) });
        if (tag) ops.push({ method: 'POST', path: `/lists/${list}/members/${mid}/tags`, body: JSON.stringify({ tags: [{ name: tag, status: 'active' }] }) });
      }
      const d = await mc('/batches', { method: 'POST', body: { operations: ops } });
      return { batchId: d.id, status: d.status };
    })
  };
}
