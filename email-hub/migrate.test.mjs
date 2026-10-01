import assert from 'node:assert/strict';
import { createMigration, readCursor } from './migrate.js';
import { createEmailHub } from './routes.js';
import { createMailchimpProvider } from './adapters/mailchimp.js';
import { createKitProvider } from './adapters/kit.js';
import { fakeMailchimp, sentCampaign } from './fake-mailchimp.mjs';
import { fakeKit } from './fake-kit.mjs';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const MC_KEY = '0123456789abcdef0123456789abcdef-us12';
const archiveStore = () => { const rows = new Map(); return { rows, saveArchived: async (r) => { rows.set(`${r.source}:${r.id}`, r); }, listArchive: async () => [...rows.values()] }; };

/* A Mailchimp list with 30 subscribed people (some tagged), plus people who must stay behind, and a Kit to receive them. */
async function world(extra = {}) {
  const mc = fakeMailchimp({ now: () => NOW });
  for (let i = 1; i <= 30; i++) {
    const tags = i % 3 === 0 ? [{ id: 1, name: 'Workshops' }, { id: 2, name: 'Members' }] : i % 3 === 1 ? [{ id: 1, name: 'Workshops' }] : [];
    mc.addMember(`person${i}@example.org`, { merge_fields: { FNAME: `Ada${i}`, LNAME: 'Example' }, tags });
  }
  mc.addMember('gone@example.org', { status: 'unsubscribed' });
  mc.addMember('bounced@example.org', { status: 'cleaned' });
  mc.addMember('waiting@example.org', { status: 'pending' });
  for (let i = 1; i <= 7; i++) mc.add(sentCampaign({ id: `sent${i}`, send_time: `2026-0${(i % 9) + 1}-02T01:00:00Z`, settings: { subject_line: `Note ${i}`, title: `Note ${i}`, preview_text: 'Hi' }, html: `<p>Body ${i}</p>` }));
  mc.add(sentCampaign({ id: 'draft1', status: 'save', html: '<p>draft</p>' }));
  const kit = fakeKit({ now: () => NOW });
  const from = createMailchimpProvider({ apiKey: MC_KEY, listId: 'LIST1' });
  const to = createKitProvider({ apiKey: 'kit_secretkey123', fetch: kit.fetch, sleep: async () => {} });
  const store = archiveStore();
  return { mc, kit, from, to, store, move: createMigration({ from, to, store, ...extra }) };
}
const drain = async (fn) => { const seen = []; let after = ''; for (let i = 0; i < 200; i++) { const r = await fn({ after }); seen.push(r); if (!r.next) return seen; after = r.next; } throw new Error('never finished'); };
const sum = (rs, k) => rs.reduce((a, r) => a + (r[k] || 0), 0);

console.log('cursor');
{
  assert.deepEqual(readCursor('25.3'), { offset: 25, index: 3 });
  assert.deepEqual(readCursor(''), { offset: 0, index: 0 });
  assert.deepEqual(readCursor('abc'), { offset: 0, index: 0 });
  assert.deepEqual(readCursor('1; DROP'), { offset: 0, index: 0 });
  ok('a cursor is two small numbers, and anything else starts again');
}

console.log('plan');
{
  const w = await world();
  try {
    const p = await w.move.plan();
    assert.equal(p.from, 'Mailchimp'); assert.equal(p.to, 'Kit');
    assert.equal(p.contacts.willMove, 30);
    assert.deepEqual(p.contacts.leftBehind, { unsubscribed: 1, cleaned: 1, pending: 1 });
    assert.equal(p.emails.sent, 7); assert.equal(p.emails.notMoved, 1); assert.equal(p.emails.canArchive, true);
    assert.equal(w.kit.state.subs.length, 0, 'planning writes nothing');
    ok('the plan counts who moves and who stays, and writes nothing');
  } finally { w.mc.restore(); }
}

console.log('contacts');
{
  const w = await world();
  try {
    const runs = await drain((a) => w.move.contacts(a));
    assert.equal(sum(runs, 'moved'), 30);
    assert.equal(sum(runs, 'failed'), 0);
    const emails = w.kit.state.subs.map((s) => s.email_address).sort();
    assert.equal(emails.length, 30);
    assert.ok(!emails.some((e) => /gone|bounced|waiting/.test(e)), 'only subscribed people moved');
    assert.ok(w.kit.state.subs.every((s) => s.state === 'active'));
    const first = w.kit.state.subs.find((s) => s.email_address === 'person1@example.org');
    assert.equal(first.first_name, 'Ada1');
    const tagNames = w.kit.state.tags.map((t) => t.name).sort();
    assert.deepEqual(tagNames, ['Members', 'Workshops']);
    const workshops = w.kit.state.tags.find((t) => t.name === 'Workshops');
    assert.equal(w.kit.state.tagged.get(workshops.id).size, 20, '10 with one tag and 10 with two');
    assert.equal(w.kit.state.tagged.get(w.kit.state.tags.find((t) => t.name === 'Members').id).size, 10);
    ok('only subscribed people move, with first name and every tag');

    const again = await drain((a) => w.move.contacts(a));
    assert.equal(w.kit.state.subs.length, 30, 'a second run does not duplicate anyone');
    assert.equal(sum(again, 'failed'), 0);
    ok('running it again duplicates nobody');
  } finally { w.mc.restore(); }
}

console.log('contacts: a small budget stops mid-page and resumes');
{
  const w = await world({ budget: 6 });
  try {
    const runs = await drain((a) => w.move.contacts(a));
    assert.ok(runs.length > 2, 'needed several requests');
    assert.ok(runs.some((r) => /^\d+\.[1-9]\d*$/.test(r.next || '')), 'stopped partway through a page');
    assert.equal(w.kit.state.subs.length, 30);
    const workshops = w.kit.state.tags.find((t) => t.name === 'Workshops');
    assert.equal(w.kit.state.tagged.get(workshops.id).size, 20);
    ok('a small call budget resumes where it stopped and still moves everyone, once');
  } finally { w.mc.restore(); }
}

console.log('contacts: someone who unsubscribed over there stays unsubscribed');
{
  const w = await world();
  try {
    w.kit.state.subs.push({ id: 900, email_address: 'person2@example.org', first_name: '', state: 'cancelled', created_at: new Date(NOW).toISOString() });
    const runs = await drain((a) => w.move.contacts(a));
    assert.equal(sum(runs, 'alreadyThere'), 1);
    assert.equal(sum(runs, 'moved'), 29);
    assert.equal(w.kit.state.subs.find((s) => s.email_address === 'person2@example.org').state, 'cancelled');
    ok('an unsubscribe in the destination is never undone');
  } finally { w.mc.restore(); }
}

console.log('contacts: one failure does not stop the run, and says nothing about the person');
{
  const w = await world();
  try {
    const real = w.kit.fetch; let hit = 0;
    const flaky = createKitProvider({ apiKey: 'kit_secretkey123', sleep: async () => {}, fetch: async (url, init) => { if (String(url).endsWith('/subscribers') && init?.method === 'POST' && ++hit === 4) return { ok: false, status: 422, headers: { get: () => null }, text: async () => 'bad person4@example.org' }; return real(url, init); } });
    const move = createMigration({ from: w.from, to: flaky, store: w.store });
    const runs = await drain((a) => move.contacts(a));
    assert.equal(sum(runs, 'failed'), 1);
    assert.equal(sum(runs, 'moved'), 29);
    assert.ok(!JSON.stringify(runs).includes('@'), 'the result carries no address');
    ok('a failure is counted, the run goes on, and no address appears in the result');
  } finally { w.mc.restore(); }
}

console.log('archive');
{
  const w = await world();
  try {
    const runs = await drain((a) => w.move.archive(a));
    assert.equal(sum(runs, 'archived'), 7);
    assert.equal(w.store.rows.size, 7);
    const one = w.store.rows.get('mailchimp:sent1');
    assert.equal(one.subject, 'Note 1'); assert.equal(one.html, '<p>Body 1</p>');
    assert.ok(!w.store.rows.has('mailchimp:draft1'), 'drafts are not archived');
    await drain((a) => w.move.archive(a));
    assert.equal(w.store.rows.size, 7, 'a second run updates the same rows');
    ok('sent emails go to the archive once each; drafts stay out');

    const noStore = createMigration({ from: w.from, to: w.to });
    await assert.rejects(() => noStore.archive({}), /nowhere to keep/);
    ok('with no store, the archive step refuses');
  } finally { w.mc.restore(); }
}

console.log('through the hub');
{
  const w = await world();
  try {
    const hub = createEmailHub({ provider: w.to, migrateFrom: w.from, store: w.store, now: () => NOW });
    const call = async (method, path, body) => { const r = await hub.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, method); return { status: r.status, body: await r.json() }; };
    assert.equal((await call('GET', '/config')).body.migrate.from, 'Mailchimp');
    assert.equal((await call('GET', '/migrate')).body.contacts.willMove, 30);
    const refused = await call('POST', '/migrate/contacts', {});
    assert.equal(refused.status, 400); assert.match(refused.body.error, /agreed to hear from you/);
    assert.equal(w.kit.state.subs.length, 0, 'nothing moves without the tick');
    const moved = await call('POST', '/migrate/contacts', { agreed: true });
    assert.equal(moved.status, 200); assert.ok(moved.body.moved > 0);
    assert.equal((await call('POST', '/migrate/archive', {})).body.archived, 5);
    assert.equal((await call('DELETE', '/migrate')).status, 405);
    ok('the routes work, and moving people needs the tick');

    const plain = createEmailHub({ provider: w.to, store: w.store, now: () => NOW });
    const off = await plain.handle(new Request('https://x/migrate'), '/migrate', 'GET');
    assert.equal(off.status, 404);
    assert.equal((await (await plain.handle(new Request('https://x/config'), '/config', 'GET')).json()).migrate, null);
    ok('without migrateFrom the feature is off');
  } finally { w.mc.restore(); }
}

console.log(`\n${n} migrate checks passed`);
