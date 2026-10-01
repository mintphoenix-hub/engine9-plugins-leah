import assert from 'node:assert/strict';
import { createEmailHubs } from './accounts.js';
import { createCrossList, readMarkCursor } from './crosslist.js';
import { createKitProvider } from './adapters/kit.js';
import { createProvider } from './adapters/index.js';
import { fakeKit } from './fake-kit.mjs';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const AT = new Date(NOW + 3 * 3600_000).toISOString();
const sub = (kit, email, state = 'active') => { const s = { id: ++kit.state.seq, email_address: email, first_name: '', state, created_at: new Date(NOW).toISOString() }; kit.state.subs.push(s); return s; };

/* Two separate Kit accounts. Main: 5 of its own, 3 shared, 1 shared who left Main. Other: 4 of its own, the 3 shared, and the one who left Main. */
function world(opts = {}) {
  const A = fakeKit({ now: () => NOW }), B = fakeKit({ now: () => NOW });
  for (let i = 1; i <= 5; i++) sub(A, `main${i}@example.org`);
  for (let i = 1; i <= 3; i++) { sub(A, `both${i}@example.org`); sub(B, `both${i}@example.org`); }
  sub(A, 'left@example.org', 'cancelled'); sub(B, 'left@example.org');
  for (let i = 1; i <= 4; i++) sub(B, `other${i}@example.org`);
  const provider = (k) => createKitProvider({ apiKey: 'kit_secretkey123', fetch: k.fetch, sleep: async () => {} });
  const brand = (name) => ({ name, style: {}, isLogoUrl: () => false });
  const hubs = createEmailHubs({ now: () => NOW, accounts: { main: { label: 'Main list', provider: provider(A), brand: brand('Main') }, other: { label: 'Other list', provider: provider(B), brand: brand('Other') } }, ...opts });
  const call = async (method, path, body) => { const r = await hubs.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path.split('?')[0], method); return r && { status: r.status, body: await r.json() }; };
  return { A, B, hubs, call, provider };
}
const markAll = async (call, primary, secondary) => { const runs = []; let after = ''; for (let i = 0; i < 100; i++) { const r = await call('POST', '/send/mark', { primary, secondary, after }); assert.equal(r.status, 200); runs.push(r.body); if (!r.body.next) return runs; after = r.body.next; } throw new Error('never finished'); };
const total = (runs, k) => runs.reduce((a, r) => a + r[k], 0);
const emailsTagged = (kit, tagId) => [...(kit.state.tagged.get(Number(tagId)) || [])].map((id) => kit.state.subs.find((s) => s.id === id).email_address).sort();

console.log('cursor');
{
  assert.deepEqual(readMarkCursor('m~abc~7'), { phase: 'm', token: 'abc', index: 7 });
  assert.deepEqual(readMarkCursor('c~a%7Eb~0'), { phase: 'c', token: 'a~b', index: 0 });
  assert.deepEqual(readMarkCursor('nonsense'), { phase: 'm', token: '', index: 0 });
  ok('the mark cursor round-trips, and anything else starts again');
}

console.log('plan');
{
  const w = world();
  const p = await w.call('GET', '/send/plan?primary=main&secondary=other');
  assert.equal(p.status, 200);
  assert.equal(p.body.primary.canEmail, 8, 'main: 5 + 3 can be emailed (the one who left is not counted)');
  assert.equal(p.body.secondary.canEmail, 8, 'other: 4 + 3 shared + 1 who left main');
  assert.equal(p.body.onBoth, 3, 'only people who can be emailed on both lists count');
  assert.equal(p.body.secondGets, 5);
  assert.equal(p.body.uniquePeople, 13, '8 + 8 - 3 different people, each emailed once');
  assert.equal(p.body.summary, '8 people can be emailed on the first list and 8 people on the second. 3 people are on both, so sending to both lists reaches 13 people, and each gets one email.');
  assert.ok(!/unsubscrib|cleaned|bounced/i.test(p.body.summary), 'the plan talks only about people who can be emailed');
  assert.equal(w.B.state.tags.length, 0, 'planning writes nothing');
  assert.equal((await w.call('GET', '/send/plan?primary=main&secondary=main')).status, 422);
  assert.equal((await w.call('GET', '/send/plan?primary=main&secondary=nope')).status, 404);
  ok('the plan counts only people who can be emailed, says how many different people both lists reach, and writes nothing');
}

console.log('mark');
{
  const w = world();
  const runs = await markAll(w.call, 'main', 'other');
  assert.equal(total(runs, 'tagged'), 3);
  const tag = runs[0].tag;
  assert.equal(tag.name, 'Also on Main list');
  assert.deepEqual(emailsTagged(w.B, tag.id), ['both1@example.org', 'both2@example.org', 'both3@example.org']);
  assert.ok(!emailsTagged(w.B, tag.id).includes('left@example.org'), 'someone who left the first list is still sent the second');
  assert.equal(w.A.state.tags.length, 0, 'the first list is only read');
  const again = await markAll(w.call, 'main', 'other');
  assert.equal(emailsTagged(w.B, tag.id).length, 3, 'marking again duplicates nothing');
  ok('marks exactly the people on both, and the first list is untouched');

  w.A.state.subs.find((s) => s.email_address === 'both2@example.org').state = 'cancelled';   // leaves the first list
  sub(w.A, 'other1@example.org');                                                              // joins the first list
  const after = await markAll(w.call, 'main', 'other');
  assert.equal(total(after, 'untagged'), 1);
  assert.deepEqual(emailsTagged(w.B, tag.id), ['both1@example.org', 'both3@example.org', 'other1@example.org']);
  ok('marking again removes the tag from people who left the first list and adds new overlaps');
}

console.log('mark: a small budget resumes and still finishes');
{
  const w = world();
  const link = createCrossList({ primary: w.hubs.hub('main') && w.provider(w.A), secondary: w.provider(w.B), tagName: 'Also on Main list', budget: 5 });
  let after = '', runs = [];
  for (let i = 0; i < 50; i++) { const r = await link.mark({ after }); runs.push(r); if (!r.next) break; after = r.next; }
  assert.ok(runs.length > 1, 'needed several requests');
  assert.equal(total(runs, 'tagged'), 3);
  ok('a small call budget stops mid-way and resumes without losing anyone');
}

console.log('draft: one list, either list');
{
  const w = world();
  const a = await w.call('POST', '/send/draft', { audiences: ['main'], subject: 'Hello', previewText: 'Hi', text: 'Hello there.' });
  assert.equal(a.status, 200); assert.equal(a.body.pair, false); assert.equal(a.body.drafts[0].account, 'main');
  assert.equal(w.A.state.broadcasts.size, 1); assert.equal(w.B.state.broadcasts.size, 0);
  const b = await w.call('POST', '/send/draft', { audiences: ['other'], subject: 'Hello', previewText: 'Hi', text: 'Hello there.' });
  assert.equal(b.body.drafts[0].account, 'other'); assert.equal(w.B.state.broadcasts.size, 1);
  assert.deepEqual([...w.B.state.broadcasts.values()][0].subscriber_filter, [], 'a single list is sent to everyone on it');
  ok('one list is an ordinary email from that account');
}

console.log('draft + schedule: both lists');
{
  const w = world();
  const runs = await markAll(w.call, 'main', 'other');
  const made = await w.call('POST', '/send/draft', { audiences: ['main', 'other'], primary: 'main', subject: 'Both lists', previewText: 'Hi', text: 'Hello there.' });
  assert.equal(made.status, 200); assert.equal(made.body.pair, true); assert.equal(made.body.needsMark, true);
  assert.deepEqual(made.body.drafts.map((d) => d.account), ['main', 'other']);
  const [first] = [...w.A.state.broadcasts.values()], [second] = [...w.B.state.broadcasts.values()];
  assert.deepEqual(first.subscriber_filter, [], 'the first list gets everyone');
  assert.deepEqual(second.subscriber_filter, [{ none: [{ type: 'tag', ids: [Number(made.body.tag.id)] }] }], 'the second gets everyone except the overlap tag');
  assert.equal(String(made.body.tag.id), String(runs[0].tag.id), 'the draft uses the tag the mark made');
  assert.equal(made.body.drafts[1].campaign.segment, 'Everyone except a tag');

  const pair = made.body.drafts.map((d) => ({ account: d.account, id: d.campaign.id }));
  const noTick = await w.call('POST', '/send/schedule', { drafts: pair, sendAt: AT, confirm: true });
  assert.equal(noTick.status, 409); assert.match(noTick.body.error, /both lists just now/);
  assert.equal(first.status, 'draft'); assert.equal(second.status, 'draft');
  const done = await w.call('POST', '/send/schedule', { drafts: pair, sendAt: AT, confirm: true, marked: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.scheduled.length, 2);
  assert.equal(first.status, 'scheduled'); assert.equal(second.status, 'scheduled');
  ok('a pair: everyone on the first, everyone except the overlap on the second, and scheduling needs the tick');
}

console.log('schedule: never half done');
{
  const w = world();
  await markAll(w.call, 'main', 'other');
  const made = await w.call('POST', '/send/draft', { audiences: ['main', 'other'], subject: 'Both lists', previewText: 'Hi', text: 'Hello there.' });
  const pair = made.body.drafts.map((d) => ({ account: d.account, id: d.campaign.id }));
  const [first] = [...w.A.state.broadcasts.values()], [second] = [...w.B.state.broadcasts.values()];
  second.status = 'scheduled';      // the second one can no longer be scheduled
  const r = await w.call('POST', '/send/schedule', { drafts: pair, sendAt: AT, confirm: true, marked: true });
  assert.ok(r.status >= 400); assert.match(r.body.error, /Nothing was scheduled/);
  assert.equal(first.status, 'draft', 'the first was taken back');
  ok('if the second cannot be scheduled the first is taken back');

  const w2 = world();
  await markAll(w2.call, 'main', 'other');
  const plain = await w2.call('POST', '/send/draft', { audiences: ['main'], subject: 'A', previewText: 'B', text: 'Hello there.' });
  const plain2 = await w2.call('POST', '/send/draft', { audiences: ['other'], subject: 'A', previewText: 'B', text: 'Hello there.' });
  const fake = await w2.call('POST', '/send/schedule', { drafts: [{ account: 'main', id: plain.body.drafts[0].campaign.id }, { account: 'other', id: plain2.body.drafts[0].campaign.id }], sendAt: AT, confirm: true, marked: true });
  assert.equal(fake.status, 409); assert.match(fake.body.error, /skip people on the first list/);
  ok('a pair is refused unless the second email really skips the first list');
}

console.log('draft: what is refused');
{
  const w = world();
  assert.equal((await w.call('POST', '/send/draft', { audiences: [], subject: 'x' })).status, 422);
  assert.equal((await w.call('POST', '/send/draft', { audiences: ['main', 'nope'], subject: 'x' })).status, 404);
  const narrowed = await w.call('POST', '/send/draft', { audiences: ['main', 'other'], to: { other: 't:12' }, subject: 'x', previewText: 'y', text: 'Hello there.' });
  assert.equal(narrowed.status, 422); assert.match(narrowed.body.error, /cannot be narrowed/);
  assert.equal(w.A.state.broadcasts.size, 0, 'nothing was left behind');
  assert.equal(await w.call('GET', '/send/nothing'), null, 'an unknown /send path is not the hub\'s');
  assert.equal((await w.call('POST', '/send/plan', {})).status, 405, 'a real step with the wrong method is refused');
  const list = await w.call('GET', '/accounts');
  assert.equal(list.body.accounts[0].canExclude, true);
  ok('no list, an unknown list, or narrowing the second list is refused and leaves nothing behind');
}

console.log('a service that cannot exclude is refused cleanly');
{
  const A = fakeKit({ now: () => NOW });
  const mc = { ...createProvider('memory', {}), label: 'Memory' };
  const noExclude = { ...mc, capabilities: { ...mc.capabilities, excludeAudience: false } };
  const hubs = createEmailHubs({ now: () => NOW, accounts: { a: { provider: createKitProvider({ apiKey: 'kit_secretkey123', fetch: A.fetch, sleep: async () => {} }) }, b: { provider: noExclude } } });
  const r = await hubs.handle(new Request('https://x/send/draft', { method: 'POST', body: JSON.stringify({ audiences: ['a', 'b'], primary: 'a', subject: 'x', previewText: 'y', text: 'Hello there.' }) }), '/send/draft', 'POST');
  assert.equal(r.status, 405);
  assert.equal(A.state.broadcasts.size, 0, 'the first draft was removed');
  ok('a second list whose service cannot exclude is refused, and the first draft is removed');
}

console.log(`\n${n} send checks passed`);
