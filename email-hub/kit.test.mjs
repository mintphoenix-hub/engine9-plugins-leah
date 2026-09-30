import assert from 'node:assert/strict';
import { createKitProvider } from './adapters/kit.js';
import { createMemoryProvider } from './adapters/memory.js';
import { createEmailHub } from './routes.js';
import { assertProvider, capabilitiesOf, HubError } from './provider.js';
import { createProvider } from './adapters/index.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const KEY = 'kit_secretkey123';
const NOW = Date.UTC(2026, 9, 1, 0, 0);

/* A Kit that records every call and answers from a table. Nothing leaves the process. */
function fakeKit(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.kit.com/v4', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method, body, key: init.headers?.['X-Kit-Api-Key'] });
    const hit = routes[`${method} ${path.split('?')[0]}`] ?? routes[`${method} *`];
    const out = typeof hit === 'function' ? hit({ path, body }) : hit;
    if (out?.__status) return { ok: false, status: out.__status, headers: { get: () => null }, text: async () => 'echo of request with a@b.co' };
    return { ok: true, status: out === undefined ? 200 : 200, headers: { get: () => null }, text: async () => JSON.stringify(out === undefined ? {} : out) };
  };
  return { fetch, calls };
}
const kitOf = (routes) => { const f = fakeKit(routes); return { ...f, provider: createKitProvider({ apiKey: KEY, fetch: f.fetch, sleep: async () => {} }) }; };
const call = (hub, method, path, body) => hub.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, method).then(async (r) => ({ status: r.status, body: await r.json() }));

console.log('the Kit provider');
{
  const { provider } = kitOf();
  assertProvider(provider);
  const c = capabilitiesOf(provider);
  assert.deepEqual([c.contacts, c.tags, c.fields, c.report, c.import, c.test, c.checklist], [true, true, true, true, false, false, false]);
  assert.equal(provider.connected(), true); assert.equal(createKitProvider({ apiKey: '' }).connected(), false);
  assert.equal(provider.appUrl('/campaigns'), 'https://app.kit.com/campaigns'); ok('it meets the contract and says what it cannot do (no import, no test send, no checklist)');
}
{
  const { provider, calls } = kitOf({
    'GET /broadcasts': { broadcasts: [
      { id: 1, status: 'completed', subject: 'Sent one', description: 'Named', created_at: '2026-09-01T00:00:00Z', send_at: '2026-09-02T00:00:00Z' },
      { id: 2, status: 'draft', subject: 'A draft', created_at: '2026-09-10T00:00:00Z', subscriber_filter: [{ all: [{ type: 'tag', ids: [5] }] }] },
      { id: 3, status: 'aborted', subject: 'Stopped', created_at: '2026-08-01T00:00:00Z' },
      { id: 4, status: 'scheduled', subject: 'Queued', created_at: '2026-09-05T00:00:00Z', send_at: '2026-10-05T00:00:00Z' },
    ], pagination: { has_next_page: false } },
    'GET /broadcasts/1/stats': { broadcast: { stats: { recipients: 200, emails_opened: 90, total_clicks: 20, open_rate: 45, click_rate: 0.1 } } },
    'GET /broadcasts/3/stats': { broadcast: { stats: { recipients: 10, emails_opened: 1, total_clicks: 0 } } },
  });
  const { campaigns } = await provider.listCampaigns();
  assert.deepEqual(campaigns.map((c) => [c.id, c.status]), [['2', 'save'], ['4', 'schedule'], ['1', 'sent'], ['3', 'sent']]);
  const sent = campaigns.find((c) => c.id === '1');
  assert.deepEqual([sent.recipients, sent.sent, sent.openRate, sent.clickRate, sent.stats, sent.when], [200, 200, 0.45, 0.1, { opened: 90, clicked: 20 }, '2026-09-02T00:00:00Z']);
  assert.equal(campaigns.find((c) => c.id === '2').segment, 'A tag');
  assert.equal(calls.filter((c) => c.path.endsWith('/stats')).length, 1, 'stats are asked for sent emails only, a stopped one included would be a second');
  ok('emails come back in the hub\'s shape: Kit\'s words mapped, rates from counts as fractions, a stopped send is "sent" (never editable)');
}
{
  const { provider } = kitOf({
    'POST /broadcasts': ({ body }) => ({ broadcast: { id: 9, status: 'draft', subject: body.subject, description: body.description, subscriber_filter: body.subscriber_filter, created_at: 'x' } }),
    'PUT /broadcasts/9': ({ body }) => ({ broadcast: { id: 9, status: body.send_at ? 'scheduled' : 'draft', subject: 'Edited', send_at: body.send_at } }),
    'GET /broadcasts/9': { broadcast: { id: 9, status: 'draft', subject: 'S', description: 'D', preview_text: 'P', content: '<p>x</p>', subscriber_filter: [{ all: [{ type: 'segment', ids: [3] }] }] } },
  });
  const made = await provider.createCampaign({ subject: 'S', previewText: 'P', title: 'T', html: '<p>x</p>', to: { segmentId: '3' } });
  assert.deepEqual([made.id, made.status, made.segment], ['9', 'save', 'A segment']);
  const { calls, provider: p2 } = kitOf({ 'POST /broadcasts': { broadcast: { id: 1, status: 'draft' } } });
  await p2.createCampaign({ subject: 'S', html: 'h', to: { tagId: '7' } });
  const b = calls[0].body; assert.deepEqual([b.send_at, b.public, b.subscriber_filter], [null, false, [{ all: [{ type: 'tag', ids: [7] }] }]]);
  await assert.rejects(p2.createCampaign({ subject: 'S', html: 'h', to: { tagId: '7/../x' } }), (e) => e instanceof HubError);
  const dup = await provider.duplicateCampaign('9'); assert.equal(dup.id, '9');
  ok('a draft is always a draft (send_at null, not public), aimed at a tag or segment, and an id cannot smuggle a path');
}
{
  const { provider, calls } = kitOf({ 'PUT /broadcasts/5': { broadcast: { id: 5 } } });
  await provider.schedule('5', '2026-10-05T10:00:00Z'); await provider.unschedule('5');
  assert.deepEqual(calls.map((c) => c.body), [{ send_at: '2026-10-05T10:00:00Z' }, { send_at: null }]); ok('scheduling and unscheduling only ever set send_at');
}
{
  const { provider } = kitOf({
    'GET /subscribers': ({ path }) => (path.includes('email_address=')
      ? { subscribers: [{ id: 1, email_address: 'ada@example.com', state: 'cancelled', first_name: 'Ada' }] }
      : { subscribers: [{ id: 1, email_address: 'ada@example.com', first_name: 'Ada', state: 'active', created_at: 'd', fields: { last_name: 'L' } }, { id: 2, email_address: 'b@example.com', state: 'inactive' }], pagination: { total_count: 2, has_next_page: true, end_cursor: 'CUR' } }),
  });
  const l = await provider.listContacts({ status: 'subscribed' });
  assert.deepEqual([l.total, l.next, l.contacts[0].state, l.contacts[0].last, l.contacts[1].state], [2, 'CUR', 'subscribed', 'L', 'pending']);
  const s = await provider.listContacts({ email: 'ADA@example.com' }); assert.deepEqual([s.search, s.contacts[0].state], [true, 'unsubscribed']);
  await assert.rejects(provider.listContacts({ email: 'ada' }), /full email/); await assert.rejects(provider.listContacts({ status: 'weird' }), /kind of contact/);
  ok('contacts: Kit\'s states become the hub\'s (active is subscribed, cancelled unsubscribed, bounced cleaned, inactive pending), searched by full address only');
}
{
  const { provider, calls } = kitOf({
    'POST /subscribers': { subscriber: { id: 4, email_address: 'gone@example.com', state: 'cancelled' } },
    'POST /tags': { tag: { id: 12, name: 'website' } },
    'POST /tags/12/subscribers': {},
  });
  const r = await provider.addContact({ email: 'Gone@Example.com', first: 'G', tag: 'website' });
  assert.equal(r.note, 'That person had unsubscribed, so they stay unsubscribed.');
  assert.equal(calls[0].body.email_address, 'gone@example.com'); assert.equal(calls.filter((c) => c.path === '/tags').length, 1);
  await provider.addContact({ email: 'x@example.com', tag: 'website' }); assert.equal(calls.filter((c) => c.path === '/tags').length, 1, 'a tag is made once, then remembered');
  ok('adding someone never resubscribes them, says so, and makes a tag once');
}
{
  let posted = [];
  const { provider } = kitOf({
    'GET /subscribers': ({ path }) => { const e = /email_address=([^&]+)/.exec(path)[1]; const m = { 'a%40b.co': 'active', 'h%40b.co': 'inactive', 'c%40b.co': 'cancelled', 'x%40b.co': 'bounced' }[e]; return { subscribers: m ? [{ id: 7, email_address: decodeURIComponent(e), state: m }] : [] }; },
    'POST /subscribers/7/unsubscribe': () => { posted.push(1); return {}; },
  });
  for (const e of ['a@b.co', 'h@b.co', 'c@b.co', 'x@b.co', 'nobody@b.co', 'nope', '{{ subscriber.email_address }}']) await provider.unsubscribeByEmail(e);
  assert.equal(posted.length, 2); ok('unsubscribe by address cancels an active or held person and leaves bounced, cancelled, unknown and malformed addresses alone');
}
{
  let hits = 0;
  const f = async () => { hits++; return hits < 3 ? { ok: false, status: 503, headers: { get: () => '1' }, text: async () => '' } : { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"account":{}}' }; };
  const waits = []; const p = createKitProvider({ apiKey: KEY, fetch: f, sleep: async (ms) => waits.push(ms) });
  await p.counts(); assert.ok(hits >= 3 && waits.length >= 2); ok('a gateway 503 is retried, waiting as long as Kit asks');
  const { provider: bad } = kitOf({ 'GET /broadcasts': { __status: 401 } });
  await assert.rejects(bad.listCampaigns(), (e) => e instanceof HubError && /did not accept/.test(e.message) && !e.message.includes(KEY));
  const { provider: echo } = kitOf({ 'GET /subscribers': { __status: 400 } });
  await assert.rejects(echo.listContacts({ status: 'subscribed' }), (e) => e instanceof HubError && !/a@b\.co/.test(e.message)); ok('errors are calm sentences: no key, no address, no response body');
}

console.log('the hub on Kit');
{
  const brand = { name: 'Example', unsubscribePage: 'https://example.org/#/unsubscribe', style: { logoUrl: 'https://example.org/l.png' } };
  const state = { posted: null };
  const { provider, calls } = kitOf({
    'POST /broadcasts': ({ body }) => { state.posted = body; return { broadcast: { id: 30, status: 'draft', subject: body.subject } }; },
    'GET /broadcasts/30': () => ({ broadcast: { id: 30, status: 'draft', subject: 'Hi', content: state.posted?.content } }),
    'PUT /broadcasts/30': { broadcast: { id: 30, status: 'scheduled' } },
  });
  const hub = createEmailHub({ provider, brand, now: () => NOW });
  const r = await call(hub, 'POST', '/campaigns', { subject: 'Hi', text: 'Hello there', to: 't:5' });
  assert.equal(r.status, 200);
  const html = state.posted.content;
  assert.ok(html.includes('https://example.org/#/unsubscribe?e={{ subscriber.email_address }}'), 'the site\'s page, with Kit\'s merge tag for the address');
  assert.ok(html.includes('{{ unsubscribe_url }}') && html.includes('Trouble unsubscribing?') && html.includes('{{ address }}'), 'Kit\'s own link stays as the fallback');
  assert.ok(html.indexOf('Unsubscribe</a>') < html.indexOf('Trouble unsubscribing?'));
  assert.deepEqual(state.posted.subscriber_filter, [{ all: [{ type: 'tag', ids: [5] }] }]);
  const inHour = new Date(NOW + 3600000).toISOString();
  assert.equal((await call(hub, 'POST', '/campaigns/30/schedule', { sendAt: inHour, confirm: false })).status, 400);
  assert.equal((await call(hub, 'POST', '/campaigns/30/schedule', { sendAt: inHour, confirm: true })).status, 200);
  assert.equal(Date.parse(calls.filter((c) => c.method === 'PUT').at(-1).body.send_at) % 900000, 0, 'sent to Kit on a quarter hour');
  ok('a composed email links to the site\'s unsubscribe page and keeps Kit\'s link; scheduling still needs the tick and a quarter hour');
  const cfg = await call(hub, 'GET', '/config'); assert.equal(cfg.body.unsubscribePage, 'https://example.org/#/unsubscribe'); assert.equal(cfg.body.label, 'Kit');
}
{
  let captured; const p = kitOf({ 'POST /broadcasts': ({ body }) => { captured = body.content; return { broadcast: { id: 1, status: 'draft' } }; } }).provider;
  await call(createEmailHub({ provider: p, brand: {}, now: () => NOW }), 'POST', '/campaigns', { subject: 'S', text: 'T' });
  assert.ok(captured.includes('{{ unsubscribe_url }}') && !captured.includes('Trouble unsubscribing?'), 'no page of its own: just the provider\'s link');
  ok('with no page of its own the email carries the provider\'s link alone');
}

console.log('unsubscribing through the site');
{
  const { unsubscribeLink, emailFromLink, handleUnsubscribe } = await import('./unsubscribe.js');
  const kit = kitOf().provider;
  assert.equal(unsubscribeLink('https://e.org/#/unsubscribe', kit), 'https://e.org/#/unsubscribe?e={{ subscriber.email_address }}');
  assert.equal(unsubscribeLink('https://e.org/u?x=1', kit), 'https://e.org/u?x=1&e={{ subscriber.email_address }}');
  assert.equal(unsubscribeLink('', kit), null); assert.equal(unsubscribeLink('https://e.org/u', { mergeTags: {} }), null, 'a provider that cannot unsubscribe by address gets no link');
  assert.equal(emailFromLink('#/unsubscribe?e=a%2Bb@x.com'), 'a+b@x.com'); assert.equal(emailFromLink('e=a+b@x.com'), 'a+b@x.com');
  for (const bad of ['', 'e=', 'e={{ subscriber.email_address }}', 'e=*|EMAIL|*', 'e=nope', '#/unsubscribe']) assert.equal(emailFromLink(bad), '', bad);
  ok('the link carries the provider\'s merge tag; the page refuses a tag the provider left as text');
  const mem = createMemoryProvider().seed({ contacts: [{ email: 'ada@example.com' }, { email: 'bo@example.com', state: 'unsubscribed' }] });
  const same = [await handleUnsubscribe(mem, { email: 'ADA@example.com' }), await handleUnsubscribe(mem, { email: 'bo@example.com' }), await handleUnsubscribe(mem, { email: 'stranger@example.com' })];
  assert.deepEqual(same.map((r) => [r.status, r.body.ok]), [[200, true], [200, true], [200, true]], 'the answer is the same whether or not they were on the list');
  assert.equal((await mem.counts()).unsubscribed, 2);
  assert.equal((await handleUnsubscribe(mem, { email: 'x@y.com', company: 'bot' })).body.ok, true); assert.equal((await mem.counts()).unsubscribed, 2, 'the honeypot does nothing');
  assert.equal((await handleUnsubscribe(mem, { email: 'not an email' })).status, 422); assert.equal((await handleUnsubscribe(mem, null)).status, 422);
  assert.equal((await handleUnsubscribe({}, { email: 'a@b.co' })).status, 501);
  const boom = { unsubscribeByEmail: async () => { throw new Error('secret key ' + KEY); }, connected: () => true };
  const failed = await handleUnsubscribe(boom, { email: 'a@b.co' }); assert.equal(failed.status, 502); assert.ok(!JSON.stringify(failed).includes(KEY));
  assert.equal((await handleUnsubscribe({ unsubscribeByEmail: async () => {}, connected: () => false }, { email: 'a@b.co' })).status, 503);
  ok('the route answers the same for every address, ignores bots, refuses junk, and never echoes a provider\'s error');
  const hub = createEmailHub({ provider: mem, brand: {} });
  assert.equal((await hub.unsubscribe({ email: 'a@b.co' })).status, 200); ok('hub.unsubscribe is the host\'s public route');
}

console.log('the memory provider and the provider list');
{
  const m = createProvider('memory'); assertProvider(m);
  assert.equal(createProvider('kit', { apiKey: KEY }).label, 'Kit'); assert.equal(createProvider('mailchimp', { apiKey: 'a'.repeat(32) + '-us1', listId: 'L' }).label, 'Mailchimp');
  assert.throws(() => createProvider('nope'), /unknown email provider/);
  const hub = createEmailHub({ provider: m, brand: {}, now: () => NOW });
  const d = await call(hub, 'POST', '/campaigns', { subject: 'S', text: 'T' }); assert.equal(d.status, 200);
  const id = d.body.campaign.id;
  assert.equal((await call(hub, 'POST', `/campaigns/${id}/schedule`, { sendAt: new Date(NOW + 3600000).toISOString(), confirm: true })).body.campaign.status, 'schedule');
  m.send(id, { opened: 0 }); assert.equal((await call(hub, 'PATCH', `/campaigns/${id}`, { subject: 'x' })).status, 409);
  ok('the memory provider runs the whole hub with no account, and a sent email cannot change');
}
console.log(`\n${n} passed`);
