/*
  One scenario, three providers. The hub's screens are written once, so every provider has to answer the hub's calls in
  the same shapes and obey the same rules. This runs the same steps through createEmailHub against Mailchimp (a stateful
  stand-in for its API), Kit (the same for its API) and the in-memory reference, and checks every answer against
  contract.js. Where a service cannot do something (Kit has no bulk import and no test send), the hub must say so with a
  405 instead of pretending, and the screens hide it.
*/
import assert from 'node:assert/strict';
import { createEmailHub } from './routes.js';
import { capabilitiesOf } from './provider.js';
import { createMailchimpProvider } from './adapters/mailchimp.js';
import { createKitProvider } from './adapters/kit.js';
import { createMemoryProvider } from './adapters/memory.js';
import { problemsWithCampaign, problemsWithContact, problemsWithAudience, problemsWithCounts, problemsWithReport } from './contract.js';
import { fakeMailchimp, sentCampaign } from './fake-mailchimp.mjs';
import { fakeKit } from './fake-kit.mjs';

const NOW = Date.UTC(2026, 9, 1, 0, 0);
const IN_AN_HOUR = new Date(NOW + 3600_000).toISOString();
const brand = { name: 'Example Studio', style: { logoUrl: 'https://example.org/logo.png', footerLine: 'Example Studio' }, isLogoUrl: () => false };
let row = null;
const store = { loadStyle: async () => row, saveStyle: async (s) => { row = s; }, resetStyle: async () => { row = null; }, logos: async () => [] };

const PROVIDERS = {
  mailchimp: () => {
    const fake = fakeMailchimp({ now: () => NOW }); fake.add(sentCampaign());
    fake.addMember('ada@example.com', { merge_fields: { FNAME: 'Ada', LNAME: 'L' } }); fake.addMember('bo@example.com', { status: 'unsubscribed' }); fake.addMember('cy@example.com');
    return { provider: createMailchimpProvider({ apiKey: '0123456789abcdef0123456789abcdef-us12', listId: 'LIST1' }), done: () => fake.restore(), unsubscribeTag: '*|UNSUB|*' };
  },
  kit: () => {
    const fake = fakeKit({ now: () => NOW });
    fake.addBroadcast({ status: 'completed', subject: 'Spring gathering', description: 'Spring gathering', content: '<p>hi</p>', send_at: '2026-08-02T01:00:00Z', stats: { recipients: 180, emails_opened: 83, total_clicks: 11, unsubscribes: 2 } });
    fake.addSubscriber('ada@example.com', { first_name: 'Ada' }); fake.addSubscriber('bo@example.com', { state: 'cancelled' }); fake.addSubscriber('cy@example.com');
    return { provider: createKitProvider({ apiKey: 'kit_secretkey123', fetch: fake.fetch, sleep: async () => {} }), done: () => {}, unsubscribeTag: '{{ unsubscribe_url }}' };
  },
  memory: () => {
    const provider = createMemoryProvider({ now: () => NOW });
    provider.seed({ contacts: [{ email: 'ada@example.com', first: 'Ada' }, { email: 'bo@example.com', state: 'unsubscribed' }, { email: 'cy@example.com' }], campaigns: [{ subject: 'Spring gathering', title: 'Spring gathering', html: '<p>hi</p>' }] });
    return { provider, done: () => {}, unsubscribeTag: '{{ unsubscribe_url }}', after: async () => { const l = await provider.listCampaigns(); provider.send(l.campaigns[0].id, { opened: 2, clicked: 1 }); } };
  }
};

let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };
const clean = (what, problems) => assert.deepEqual(problems, [], `${what}: ${problems.join('; ')}`);

for (const [name, make] of Object.entries(PROVIDERS)) {
  console.log(name);
  row = null;
  const { provider, done, unsubscribeTag, after } = make(); if (after) await after();
  const hub = createEmailHub({ provider, brand, store, now: () => NOW });
  const caps = capabilitiesOf(provider);
  const call = async (method, path, body) => { const r = await hub.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path.split('?')[0], method); return { status: r.status, body: await r.json() }; };
  try {
    const cfg = (await call('GET', '/config')).body;
    assert.ok(cfg.label && Object.values(cfg.capabilities).every((v) => typeof v === 'boolean')); ok('says what it is and what it can do');

    const list = (await call('GET', '/campaigns')).body;
    assert.equal(list.connected, true); list.campaigns.forEach((c) => clean('campaign', problemsWithCampaign(c)));
    const sent = list.campaigns.find((c) => c.status === 'sent'); assert.ok(sent, 'a sent email is listed');
    assert.ok(sent.openRate > 0 && sent.openRate <= 1 && sent.recipients > 0); ok('lists emails in the contract shape, with rates as fractions');

    const made = (await call('POST', '/campaigns', { subject: 'Hello', previewText: 'Hi there', text: 'Hi\n\nSee https://example.org', to: '' })).body.campaign;
    clean('created', problemsWithCampaign(made)); assert.deepEqual([made.status, made.subject], ['save', 'Hello']);
    const html = (await call('GET', `/campaigns/${made.id}/content`)).body.html;
    assert.ok(html.includes(unsubscribeTag) && html.includes('https://example.org/logo.png') && html.includes('Hi')); ok('a new email is a draft carrying the look and this service\'s own unsubscribe tag');

    assert.equal((await call('PATCH', `/campaigns/${made.id}`, { subject: 'Hello again' })).body.campaign.subject, 'Hello again');
    assert.equal((await call('PATCH', `/campaigns/${made.id}`, { subject: ' ' })).status, 400); ok('a draft can be edited, and not into nothing');

    assert.equal((await call('POST', `/campaigns/${made.id}/schedule`, { sendAt: IN_AN_HOUR, confirm: false })).status, 400);
    assert.equal((await call('POST', `/campaigns/${made.id}/schedule`, { sendAt: new Date(NOW).toISOString(), confirm: true })).status, 400);
    const sch = await call('POST', `/campaigns/${made.id}/schedule`, { sendAt: IN_AN_HOUR, confirm: true });
    if (caps.checklist === false || sch.status === 200) { assert.equal(sch.status, 200, JSON.stringify(sch.body)); assert.equal(sch.body.campaign.status, 'schedule'); assert.equal(Date.parse(sch.body.scheduledFor) % 900000, 0); }
    assert.equal((await call('POST', `/campaigns/${made.id}/schedule`, { sendAt: IN_AN_HOUR, confirm: true })).status, 409);
    assert.equal((await call('POST', `/campaigns/${made.id}/unschedule`)).body.campaign.status, 'save');
    assert.equal((await call('POST', `/campaigns/${made.id}/unschedule`)).status, 409); ok('scheduling is guarded the same way: tick, notice, quarter hour, drafts only, and it can be taken back');

    for (const [m, p, b] of [['PATCH', `/campaigns/${sent.id}`, { subject: 'x' }], ['DELETE', `/campaigns/${sent.id}`], ['POST', `/campaigns/${sent.id}/schedule`, { sendAt: IN_AN_HOUR, confirm: true }]]) assert.equal((await call(m, p, b)).status, 409);
    ok('a sent email can never be changed, scheduled again or deleted');

    const dup = (await call('POST', `/campaigns/${made.id}/duplicate`)).body.campaign; clean('duplicate', problemsWithCampaign(dup)); assert.notEqual(dup.id, made.id); assert.equal(dup.status, 'save');
    assert.equal((await call('DELETE', `/campaigns/${dup.id}`)).status, 200); assert.equal((await call('DELETE', `/campaigns/${made.id}`)).status, 200);
    assert.ok(!(await call('GET', '/campaigns')).body.campaigns.some((c) => [dup.id, made.id].includes(c.id))); ok('an email can be copied, and a draft deleted');

    if (caps.report) { const r = (await call('GET', `/campaigns/${sent.id}/report`)).body; clean('report', problemsWithReport(r)); assert.ok(r.recipients > 0); ok('a sent email has a report'); }
    else assert.equal((await call('GET', `/campaigns/${sent.id}/report`)).status, 405);

    const aud = (await call('GET', '/audience')).body; clean('audience', problemsWithAudience(aud)); assert.ok(Number.isFinite(aud.subscribers) && aud.subscribers > 0); ok('the audience has its size, tags and segments');
    const ov = (await call('GET', '/overview')).body; clean('counts', problemsWithCounts(ov.counts.data)); assert.deepEqual([ov.counts.ok, ov.growth30.ok, ov.growth90.ok], [true, true, true]);
    assert.deepEqual([ov.counts.data.subscribed, ov.counts.data.unsubscribed], [2, 1]); assert.ok(Number.isFinite(ov.growth30.data.added) && Number.isFinite(ov.email90.data.sent)); ov.campaigns.forEach((c) => clean('overview campaign', problemsWithCampaign(c))); ok('Home and Analytics numbers come back whole');

    const cs = (await call('GET', '/contacts?status=subscribed&counts=1')).body; cs.contacts.forEach((c) => clean('contact', problemsWithContact(c)));
    assert.deepEqual([cs.total, cs.contacts.length, cs.counts.unsubscribed], [2, 2, 1]);
    const ada = cs.contacts.find((c) => c.email === 'ada@example.com'); const cy = cs.contacts.find((c) => c.email === 'cy@example.com');
    assert.equal((await call('GET', '/contacts?email=ADA@example.com')).body.contacts.length, 1); assert.equal((await call('GET', '/contacts?email=nobody@example.com')).body.contacts.length, 0);
    assert.equal((await call('GET', '/contacts?email=not-an-address')).status, 400); assert.equal((await call('GET', '/contacts?status=unsubscribed')).body.contacts[0].email, 'bo@example.com'); ok('contacts are listed by state and found by address');

    clean('one contact', problemsWithContact((await call('GET', `/contacts/${ada.id}`)).body));
    if (caps.tags) {
      const t = (await call('POST', '/tags', { name: 'Workshop' })).body.tag; assert.equal(t.name, 'Workshop');
      await call('POST', `/contacts/${ada.id}/tags`, { name: 'Workshop' });
      assert.deepEqual((await call('GET', `/contacts/${ada.id}`)).body.tags.map((x) => x.name), ['Workshop']);
      const tagId = (await call('GET', '/audience')).body.tags.find((x) => x.name === 'Workshop').id;
      assert.deepEqual((await call('GET', `/contacts?tag=${tagId}`)).body.contacts.map((c) => c.email), ['ada@example.com']);
      await call('DELETE', `/contacts/${ada.id}/tags`, { name: 'Workshop' }); assert.equal((await call('GET', `/contacts/${ada.id}`)).body.tags.length, 0);
      assert.equal((await call('POST', '/tags', { name: '  ' })).status, 400); ok('tags are made, added, removed and filtered by');
    }

    assert.equal((await call('POST', '/contacts', { email: 'new@example.com' })).status, 400); assert.equal((await call('POST', '/contacts', { email: 'nope', consent: true })).status, 400);
    const added = (await call('POST', '/contacts', { email: 'New@Example.com', first: 'Nia', consent: true })).body; clean('added', problemsWithContact(added.contact)); assert.equal(added.contact.state, 'subscribed');
    const again = (await call('POST', '/contacts', { email: 'bo@example.com', consent: true })).body; assert.equal(again.contact.state, 'unsubscribed'); assert.match(again.note, /unsubscribed/);
    await call('POST', `/contacts/${cy.id}/unsubscribe`); assert.equal((await call('GET', `/contacts/${cy.id}`)).body.state, 'unsubscribed'); ok('adding needs consent, never resubscribes someone who left, and unsubscribing sticks');

    if (caps.fields) assert.ok(Array.isArray((await call('GET', '/fields')).body.fields));
    if (caps.import) { const r = (await call('POST', '/import', { people: [{ email: 'imp@example.com' }, { email: 'bad' }] })).body; assert.deepEqual([r.count, r.invalid], [1, 1]); }
    else assert.equal((await call('POST', '/import', { people: [{ email: 'imp@example.com' }] })).status, 405);
    if (!caps.test) assert.equal((await call('POST', `/campaigns/${sent.id}/test`, { emails: ['a@example.com'] })).status, 405);
    ok('what this service cannot do is refused plainly, not faked');

    assert.equal((await call('PATCH', '/look', { ground: '#101010' })).body.style.ground, '#101010'); assert.equal((await call('PATCH', '/look', { reset: true })).status, 200); ok('the look works on any provider');
  } finally { done(); }
}
console.log(`${passed} passed`);
