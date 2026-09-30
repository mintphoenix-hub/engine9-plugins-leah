import assert from 'node:assert/strict';
import { createEmailHub } from './routes.js';
import { createMailchimpProvider } from './adapters/mailchimp.js';
import { checkStyle, defaultStyle, emailShell, bodyHtml, DEFAULT_STYLE, StyleError } from './shell.js';
import { planSchedule } from './schedule.js';
import { parseCsv, cleanPeople } from './csv.js';
import { emailsIn } from './stats.js';
import { assertProvider, capabilitiesOf, HubError } from './provider.js';
import { wallToUtc } from './time.js';
import { fakeMailchimp, sentCampaign } from './fake-mailchimp.mjs';

let n = 0;
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const KEY = '0123456789abcdef0123456789abcdef-us12';
const brand = { name: 'Example Studio', style: { ground: '#EAF2F0', logoUrl: 'https://example.org/logo.png', logoWidth: 260, footerLine: 'Example Studio, Somewhere' }, isLogoUrl: (u) => /^https:\/\/example\.org\/media\/[a-f0-9]{16}$/.test(u) };
const memoryStore = () => { let row = null; return { loadStyle: async () => row, saveStyle: async (s) => { row = s; }, resetStyle: async () => { row = null; }, logos: async () => [{ id: 'builtin', name: 'Logo', url: brand.style.logoUrl }] }; };
const t = async (name, fn) => {
  const fake = fakeMailchimp({ now: () => NOW }); fake.add(sentCampaign());
  const provider = createMailchimpProvider({ apiKey: KEY, listId: 'LIST1' });
  const store = memoryStore();
  const hub = createEmailHub({ provider, brand, store, now: () => NOW });
  const call = async (method, path, body) => { const r = await hub.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path.split('?')[0], method); return { status: r.status, body: await r.json() }; };
  try { await fn({ fake, call, hub, provider, store }); } finally { fake.restore(); }
  n++; console.log('  ok  ' + name);
};
const IN_AN_HOUR = new Date(NOW + 3600_000).toISOString();
const newDraft = (call, over = {}) => call('POST', '/campaigns', { subject: 'Spring gathering', previewText: 'Save the date', text: 'Hello there.\n\nSee https://example.org', ...over });

console.log('pure pieces');
{
  const a = emailShell('x', { address: 'ADDR', unsubscribe: 'UNS', brand });
  assert.ok(a.includes('#EAF2F0') && a.includes('https://example.org/logo.png') && a.includes('width="260"') && a.includes('Example Studio, Somewhere') && a.includes('ADDR') && a.includes('UNS'));
  const b = emailShell('x', { style: checkStyle({ ground: '#101010', logoWidth: 180, footerLine: 'Other' }, brand), brand });
  assert.ok(b.includes('#101010') && b.includes('width="180"') && b.includes('Other') && !b.includes('#EAF2F0'));
  assert.ok(bodyHtml('see https://a.example', { style: checkStyle({ link: '#123456' }, brand), brand }).includes('color:#123456;text-decoration:underline'));
  assert.equal(emailShell('x').includes('undefined'), false); n++; console.log('  ok  the shell takes its look from the brand, a saved style, and neutral defaults');
  assert.equal(checkStyle({ link: '#aa00bb' }, brand).link, '#AA00BB');
  assert.throws(() => checkStyle({ link: 'red' }, brand), StyleError); assert.throws(() => checkStyle({ logoWidth: 9 }, brand), StyleError);
  assert.throws(() => checkStyle({ logoUrl: 'https://evil.example/x.png' }, brand), /logos shown/);
  assert.equal(checkStyle({ logoUrl: 'https://example.org/media/aaaaaaaaaaaaaaaa' }, brand).logoUrl.endsWith('aaaaaaaaaaaaaaaa'), true);
  assert.equal(checkStyle({ footerLine: '<b>Hi</b> "there"' }, brand).footerLine, 'b Hi /b there');
  assert.deepEqual(defaultStyle({}), DEFAULT_STYLE); n++; console.log('  ok  a style is checked: colours, logo, width, footer');
  const p = planSchedule(IN_AN_HOUR, true, NOW); assert.equal(p.at % 900000, 0);
  assert.throws(() => planSchedule(IN_AN_HOUR, false, NOW), /Tick the box/); assert.throws(() => planSchedule(new Date(NOW).toISOString(), true, NOW), /15 minutes/); assert.throws(() => planSchedule('nope', true, NOW), /Pick a day/);
  assert.equal(planSchedule(new Date(NOW + 20 * 60_000 + 1).toISOString(), true, NOW).at, NOW + 30 * 60_000); n++; console.log('  ok  scheduling needs the tick, 15 minutes notice, and rounds up to a quarter hour');
  const csv = parseCsv('Email,First Name,Last\nnew1@example.com,Nia,Ray\n"x@example.com",Xi,"Y, Z"\nbad,No,One\n');
  assert.deepEqual([csv.people.length, csv.people[1].last, csv.column], [3, 'Y, Z', 'Email']);
  assert.deepEqual(cleanPeople(csv.people).invalid, 1); assert.equal(parseCsv('a@example.com\nb@example.com').people.length, 2); n++; console.log('  ok  a CSV is read with quotes and with or without a header');
  const all = [{ status: 'sent', when: new Date(NOW - 5 * 86400_000).toISOString(), sent: 100, openRate: 0.5, clickRate: 0.1 }, { status: 'sent', when: new Date(NOW - 50 * 86400_000).toISOString(), sent: 100, openRate: 0.3, clickRate: 0.02 }];
  assert.deepEqual([emailsIn(all, 30, NOW).emails, emailsIn(all, 90, NOW).emails, Math.round(emailsIn(all, 90, NOW).openRate * 100)], [1, 2, 40]); n++; console.log('  ok  sends in a period are counted and weighted');
  assert.throws(() => assertProvider({}), /label/); assert.throws(() => assertProvider({ label: 'X', mergeTags: { address: 'a', unsubscribe: 'u' } }), /missing/);
  const p2 = createMailchimpProvider({ apiKey: KEY, listId: 'L' }); assertProvider(p2); assert.equal(capabilitiesOf(p2).contacts, true); n++; console.log('  ok  a provider is checked for what the hub always needs');
}

assert.equal(wallToUtc('2026-10-03T10:00', 'Australia/Brisbane'), Date.UTC(2026, 9, 3, 0, 0));
assert.equal(wallToUtc('2026-07-03T10:00', 'America/New_York'), Date.UTC(2026, 6, 3, 14, 0));      // daylight time
assert.equal(wallToUtc('2026-12-03T10:00', 'America/New_York'), Date.UTC(2026, 11, 3, 15, 0));     // standard time
assert.equal(wallToUtc('2026-10-03T10:00', 'UTC'), Date.UTC(2026, 9, 3, 10, 0)); assert.ok(Number.isNaN(wallToUtc('nope', 'UTC'))); n++; console.log('  ok  a wall-clock time is read in the site\'s own time zone, daylight saving included');

console.log('campaigns');
await t('her emails come back shaped for the screen, with numbers for the sent ones', async ({ call, fake }) => {
  const d = await newDraft(call); await call('POST', `/campaigns/${d.body.campaign.id}/schedule`, { sendAt: IN_AN_HOUR, confirm: true });
  const r = await call('GET', '/campaigns'); assert.equal(r.body.campaigns.length, 2); assert.equal(r.body.dc, 'us12');
  const sent = r.body.campaigns.find((c) => c.id === 'sent1');
  assert.deepEqual([sent.status, sent.subject, sent.recipients, sent.openRate, sent.stats], ['sent', 'Spring gathering', 180, 0.46, { opened: 83, clicked: 11 }]);
  assert.equal(fake.calls.find((c) => c.path === '/campaigns' && c.method === 'GET').query.type, 'regular');
});
await t('a draft is made with the brand look, the merge tags, and the chosen audience', async ({ call, fake }) => {
  const r = await newDraft(call, { to: 't:11' }); assert.equal(r.status, 200);
  const html = fake.state.campaigns.get(r.body.campaign.id).html;
  assert.ok(html.includes('*|UNSUB|*') && html.includes('*|LIST:ADDRESSLINE|*') && html.includes('https://example.org/logo.png') && html.includes('Hello there.'));
  assert.equal(fake.calls.find((c) => c.method === 'POST' && c.path === '/campaigns').body.recipients.segment_opts.conditions[0].value, 11);
  assert.equal((await newDraft(call, { subject: '  ' })).status, 400); assert.equal((await newDraft(call, { text: ' ' })).status, 400);
});
await t('scheduling is guarded end to end', async ({ call, fake }) => {
  const id = (await newDraft(call)).body.campaign.id;
  assert.equal((await call('POST', `/campaigns/${id}/schedule`, { sendAt: IN_AN_HOUR, confirm: false })).status, 400);
  assert.equal((await call('POST', `/campaigns/${id}/schedule`, { sendAt: new Date(NOW).toISOString(), confirm: true })).status, 400);
  const ok = await call('POST', `/campaigns/${id}/schedule`, { sendAt: IN_AN_HOUR, confirm: true });
  assert.deepEqual([ok.status, ok.body.campaign.status], [200, 'schedule']); assert.equal(Date.parse(ok.body.scheduledFor) % 900000, 0);
  assert.equal((await call('POST', `/campaigns/${id}/schedule`, { sendAt: IN_AN_HOUR, confirm: true })).status, 409);       // no longer a draft
  assert.equal((await call('POST', `/campaigns/${id}/unschedule`)).body.campaign.status, 'save');
  assert.equal((await call('POST', `/campaigns/${id}/unschedule`)).status, 409);
  const sent = await call('POST', '/campaigns/sent1/schedule', { sendAt: IN_AN_HOUR, confirm: true }); assert.equal(sent.status, 409);
  const empty = await call('POST', '/campaigns', { subject: 'S', text: 'T' }); fake.state.campaigns.get(empty.body.campaign.id).html = '';
  const notReady = await call('POST', `/campaigns/${empty.body.campaign.id}/schedule`, { sendAt: IN_AN_HOUR, confirm: true }); assert.equal(notReady.status, 409); assert.match(notReady.body.error, /not ready to send/);
});
await t('only a draft can change or go; a duplicate is a draft; a test goes to at most three addresses', async ({ call }) => {
  const id = (await newDraft(call)).body.campaign.id;
  assert.equal((await call('PATCH', `/campaigns/${id}`, { subject: 'New subject' })).body.campaign.subject, 'New subject');
  assert.equal((await call('PATCH', `/campaigns/${id}`, { subject: ' ' })).status, 400); assert.equal((await call('PATCH', '/campaigns/sent1', { subject: 'x' })).status, 409); assert.equal((await call('DELETE', '/campaigns/sent1')).status, 409);
  assert.equal((await call('POST', '/campaigns/sent1/duplicate')).body.campaign.status, 'save');
  assert.equal((await call('POST', `/campaigns/${id}/test`, { emails: ['a@example.com', 'A@example.com'] })).body.sentTo.length, 1);
  assert.equal((await call('POST', `/campaigns/${id}/test`, { emails: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'] })).status, 400);
  assert.equal((await call('POST', `/campaigns/${id}/test`, { emails: ['nope'] })).status, 400); assert.equal((await call('POST', `/campaigns/${id}/test`, {})).status, 400);
  assert.equal((await call('DELETE', `/campaigns/${id}`)).status, 200);
});
await t('a report and the email content are read for one email', async ({ call }) => {
  const r = (await call('GET', '/campaigns/sent1/report')).body; assert.deepEqual([r.recipients, r.opened, r.clicked, r.unsubscribed, r.bounced], [180, 83, 11, 2, 1]);
  assert.equal((await call('GET', '/campaigns/sent1/content')).body.html, '<p>hi</p>');
});
await t('Mailchimp errors become calm sentences and the key never appears in one', async ({ call, fake }) => {
  fake.failNext('GET', /\/campaigns/, 401, `key ${KEY} is bad`); const r = await call('GET', '/campaigns');
  assert.equal(r.status, 502); assert.match(r.body.error, /did not accept/); assert.ok(!JSON.stringify(r.body).includes(KEY));
  fake.failNext('POST', /\/actions\/replicate/, 400, 'This account cannot do that'); const d = await call('POST', '/campaigns/sent1/duplicate');
  assert.equal(d.status, 409); assert.match(d.body.error, /This account cannot do that/);
  fake.failNext('GET', /\/campaigns\/sent1$/, 404, 'gone'); assert.equal((await call('PATCH', '/campaigns/sent1', { subject: 'x' })).status, 404);
});
await t('not connected: reads answer empty, writes are refused', async () => {
  const hub = createEmailHub({ provider: createMailchimpProvider({ apiKey: '', listId: '' }), brand });
  const g = await hub.handle(new Request('https://x/campaigns'), '/campaigns', 'GET'); assert.deepEqual([g.status, (await g.json()).connected], [200, false]);
  const p = await hub.handle(new Request('https://x/campaigns', { method: 'POST', body: '{}' }), '/campaigns', 'POST'); assert.equal(p.status, 503);
  assert.equal(await hub.handle(new Request('https://x/other'), '/other', 'GET'), null);
});

console.log('audience');
await t('contacts come back by state, addressed by member id, and are found by full address', async ({ call, fake }) => {
  fake.addMember('ada@example.com', { merge_fields: { FNAME: 'Ada', LNAME: 'L' } }); fake.addMember('bo@example.com', { status: 'unsubscribed' });
  const r = (await call('GET', '/contacts?status=subscribed&counts=1')).body;
  assert.deepEqual([r.total, r.contacts[0].email, r.contacts[0].first, /^[a-f0-9]{32}$/.test(r.contacts[0].id), r.counts], [1, 'ada@example.com', 'Ada', true, { subscribed: 1, unsubscribed: 1, cleaned: 0, pending: 0 }]);
  assert.equal((await call('GET', '/contacts?email=ADA@example.com')).body.contacts.length, 1); assert.equal((await call('GET', '/contacts?email=nobody@example.com')).body.contacts.length, 0);
  assert.equal((await call('GET', '/contacts?email=not-an-address')).status, 400); assert.equal((await call('GET', '/contacts/abc')).status, 404);
});
await t('tags: added, removed, filtered by, created', async ({ call, fake }) => {
  const p = fake.addMember('ada@example.com'); fake.addMember('bo@example.com');
  await call('POST', `/contacts/${p.id}/tags`, { name: 'Workshop' }); const tag = fake.state.tags.find((x) => x.name === 'Workshop');
  assert.deepEqual((await call('GET', `/contacts?tag=${tag.id}`)).body.contacts.map((c) => c.email), ['ada@example.com']);
  assert.deepEqual((await call('GET', `/contacts/${p.id}`)).body.tags.map((x) => x.name), ['Workshop']);
  await call('DELETE', `/contacts/${p.id}/tags`, { name: 'Workshop' }); assert.equal((await call('GET', `/contacts/${p.id}`)).body.tags.length, 0);
  assert.equal((await call('POST', '/tags', { name: 'Spring' })).body.tag.name, 'Spring'); assert.equal((await call('POST', '/tags', { name: ' ' })).status, 400);
});
await t('adding someone needs the consent tick and a real address, and never resubscribes an unsubscribed person', async ({ call, fake }) => {
  assert.equal((await call('POST', '/contacts', { email: 'new@example.com' })).status, 400); assert.equal((await call('POST', '/contacts', { email: 'nope', consent: true })).status, 400);
  const r = await call('POST', '/contacts', { email: 'New@Example.com', first: 'Nia', consent: true, tag: 'Website' });
  assert.deepEqual([r.body.contact.email, r.body.contact.first, r.body.contact.state], ['new@example.com', 'Nia', 'subscribed']);
  const put = fake.calls.find((c) => c.method === 'PUT'); assert.equal(put.body.status_if_new, 'subscribed'); assert.ok(!('status' in put.body));
});
await t('unsubscribe changes only the status', async ({ call, fake }) => {
  const p = fake.addMember('ada@example.com'); await call('POST', `/contacts/${p.id}/unsubscribe`); assert.equal(fake.state.members[0].status, 'unsubscribed');
});
await t('import: pending unless they agreed, invalid rows counted', async ({ call, fake }) => {
  const r = (await call('POST', '/import', { people: [{ email: 'a@example.com', first: 'A' }, { email: 'a@example.com' }, { email: 'bad' }], tag: 'Buyers' })).body;
  assert.deepEqual([r.count, r.invalid], [1, 1]); assert.equal(fake.state.members[0].status, 'pending');
  await call('POST', '/import', { people: [{ email: 'b@example.com' }], agreed: true }); assert.equal(fake.state.members.at(-1).status, 'subscribed');
  assert.equal((await call('POST', '/import', { people: [{ email: 'bad' }] })).status, 400);
});
await t('Home numbers: new and unsubscribed in the window, and sends weighted by size', async ({ call, fake }) => {
  fake.add(sentCampaign({ id: 'recent', send_time: '2026-09-20T01:00:00Z' })); fake.addMember('new@example.com'); fake.addMember('gone@example.com', { status: 'unsubscribed' });
  const o = (await call('GET', '/overview')).body;
  assert.deepEqual([o.growth30.data.added, o.growth30.data.unsubscribed, o.growth30.data.net, o.email30.data.emails, o.email90.data.emails, Math.round(o.email30.data.openRate * 100) / 100], [1, 1, 0, 1, 2, 0.46]);
  assert.equal((await call('GET', '/fields')).body.fields[0].tag, 'EMAIL'); assert.equal((await call('GET', '/audience')).body.tags.length, 2);
});

console.log('look');
await t('the look: read with defaults, saved, applied to new emails, and put back', async ({ call, fake }) => {
  assert.equal((await call('GET', '/look')).body.style.ground, '#EAF2F0');
  assert.equal((await call('PATCH', '/look', { ground: '#0A0B0C' })).body.style.ground, '#0A0B0C');
  const id = (await newDraft(call)).body.campaign.id; assert.ok(fake.state.campaigns.get(id).html.includes('#0A0B0C'));
  assert.equal((await call('PATCH', '/look', { link: 'red' })).status, 400); assert.equal((await call('PATCH', '/look', { logoUrl: 'https://evil.example/x.png' })).status, 400);
  assert.equal((await call('PATCH', '/look', { reset: true })).body.style.ground, '#EAF2F0'); assert.equal((await call('GET', '/look')).body.style.ground, '#EAF2F0');
  assert.equal((await call('GET', '/config')).body.label, 'Mailchimp');
});
await t('with no store the look is read-only and saying so is calm', async ({ provider }) => {
  const hub = createEmailHub({ provider, brand }); const r = await hub.handle(new Request('https://x/look', { method: 'PATCH', body: JSON.stringify({ ground: '#101010' }) }), '/look', 'PATCH');
  assert.equal(r.status, 503); assert.match((await r.json()).error, /not switched on/);
});
await t('a postal address in the look replaces the merge tag in the footer, and is escaped', async ({ call, fake }) => {
  const id0 = (await newDraft(call)).body.campaign.id; assert.ok(fake.state.campaigns.get(id0).html.includes('*|LIST:ADDRESSLINE|*'));       // none saved: the service's own address
  const saved = await call('PATCH', '/look', { address: 'Unit 2 & 3\n12 Example St\nSomewhere QLD 4000' });
  assert.equal(saved.body.style.address, 'Unit 2 & 3, 12 Example St, Somewhere QLD 4000');
  const html = fake.state.campaigns.get((await newDraft(call)).body.campaign.id).html;
  assert.ok(html.includes('Unit 2 &amp; 3, 12 Example St, Somewhere QLD 4000') && !html.includes('*|LIST:ADDRESSLINE|*') && html.includes('*|UNSUB|*'));
  assert.equal(emailShell('x', { address: 'MERGE', style: { address: '<b>x</b>' } }).includes('<b>x</b>'), false);
  assert.equal((await call('PATCH', '/look', { address: '' })).body.style.address, ''); assert.ok(fake.state.campaigns.get((await newDraft(call)).body.campaign.id).html.includes('*|LIST:ADDRESSLINE|*'));
});

console.log('pasted HTML');
import { cleanEmailHtml, checkEmailHtml } from './pasted.js';
{
  const page = (extra = '') => `<html><body style="margin:0"><table width="100%"><tr><td><h1>Spring evening</h1><p>Join us.</p><img src="https://example.org/a.jpg" alt="">${extra}<p><a href="*|UNSUB|*">Unsubscribe</a></p></td></tr></table></body></html>`;
  await t('pasted HTML is saved as it is, without the hub\'s own shell', async ({ fake, call }) => {
    const r = await call('POST', '/campaigns', { subject: 'Pasted', html: page() });
    assert.equal(r.status, 200);
    const sent = fake.calls.find((c) => c.method === 'PUT' && /\/content$/.test(c.path)).body.html;
    assert.equal(sent, page());                            // untouched: nothing wrapped around it
    assert.ok(!sent.includes('Loving') && !r.body.warnings?.some((w) => /unsubscribe/i.test(w)));
  });
  await t('scripts, frames, forms, handlers and javascript: links are removed', async ({ fake, call }) => {
    const dirty = page('<script>alert(1)</script><iframe src="https://evil.test"></iframe><form action="/x"><input name="a"></form><a href="javascript:alert(2)" onclick="steal()">x</a><img src="x" onerror="steal()"><div style="behavior:url(x.htc)">y</div><svg onload="z()"></svg>');
    await call('POST', '/campaigns', { subject: 'Dirty', html: dirty });
    const sent = fake.calls.find((c) => c.method === 'PUT' && /\/content$/.test(c.path)).body.html;
    for (const bad of ['<script', 'alert(1)', '<iframe', '<form', 'onclick', 'onerror', 'javascript:', 'behavior', '<svg']) assert.ok(!sent.toLowerCase().includes(bad), bad);
    assert.ok(sent.includes('Spring evening') && sent.includes('*|UNSUB|*'));
  });
  await t('an email with no unsubscribe tag is refused, and nothing is created', async ({ fake, call }) => {
    const r = await call('POST', '/campaigns', { subject: 'No opt-out', html: '<html><body><p>Hi</p></body></html>' });
    assert.equal(r.status, 400); assert.match(r.body.error, /unsubscribe/i);
    assert.ok(!fake.calls.some((c) => c.method === 'POST' && c.path === '/campaigns'));
  });
  await t('empty HTML is refused; plain text still works beside it', async ({ call }) => {
    const r = await call('POST', '/campaigns', { subject: 'Empty', html: '<html><body>*|UNSUB|*</body></html>' });
    assert.equal(r.status, 400);
    assert.equal((await newDraft(call)).status, 200);
  });
  await t('warnings come back with the draft', async ({ call }) => {
    const r = await call('POST', '/campaigns', { subject: 'Pics', html: '<html><body><p>Hello friends</p><img src="/local.jpg" alt=""><a href="*|UNSUB|*">Unsubscribe</a></body></html>' });
    assert.equal(r.status, 200); assert.ok(r.body.warnings.some((w) => /https/.test(w)));
  });
  await t('the settings tell the page which unsubscribe tag to ask for', async ({ call }) => {
    assert.equal((await call('GET', '/config')).body.mergeTags.unsubscribe, '*|UNSUB|*');
  });
  assert.equal(cleanEmailHtml('<p>ok</p><!-- x --><!--[if mso]><table></table><![endif]-->'), '<p>ok</p><!--[if mso]><table></table><![endif]-->');
  assert.equal(checkEmailHtml('<p>Hi</p>', { unsubscribe: '{{ unsubscribe_url }}' }).errors.length, 1);
}

console.log(`${n} passed`);
