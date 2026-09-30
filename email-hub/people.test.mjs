import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createCorePeople, emailHash, normalizeEmail, quietly } from './people.js';
import { createEmailHub } from './routes.js';
import { createMemoryProvider } from './adapters/memory.js';
import { handleUnsubscribe } from './unsubscribe.js';
import { metadata } from './index.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };

/* core's standard person and person_email tables (interfaces/person, person_email), as core creates them. */
function coreDb() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE person (id INTEGER PRIMARY KEY AUTOINCREMENT, given_name TEXT, family_name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, modified_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE person_email (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL DEFAULT 0, email_type TEXT NOT NULL DEFAULT 'Personal', email TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'Not Subscribed', confirmation_status TEXT DEFAULT 'Not Confirmed', deliverability_score INTEGER NOT NULL DEFAULT 1,
      preference_order INTEGER NOT NULL DEFAULT 0, email_hash_v1 TEXT NOT NULL DEFAULT '', source_input_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, modified_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  const run = (st, a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { const r = st.run(...a); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; } });
  const db = { prepare: (sql) => { const st = raw.prepare(sql); return { ...run(st, []), bind: (...a) => run(st, a) }; } };
  return {
    db,
    person: (given = null, family = null) => Number(raw.prepare('INSERT INTO person (given_name, family_name) VALUES (?,?)').run(given, family).lastInsertRowid),
    email: async (pid, email, status, opts = {}) => raw.prepare('INSERT INTO person_email (person_id, email, subscription_status, email_hash_v1) VALUES (?,?,?,?)').run(pid, opts.noText ? null : email, status, await emailHash(email)),
    rows: () => raw.prepare('SELECT pe.id, pe.person_id, pe.email, pe.subscription_status s, p.given_name g, p.family_name f FROM person_email pe LEFT JOIN person p ON p.id = pe.person_id ORDER BY pe.id').all(),
    people: () => raw.prepare('SELECT COUNT(*) c FROM person').get().c,
  };
}

console.log('core\'s rules');
{
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.equal(await emailHash(' ADA@example.com'), await emailHash('ada@example.com'), 'core\'s email_hash_v1: sha256 of the trimmed, lower-cased address');
  assert.match(await emailHash('a@b.co'), /^[0-9a-f]{64}$/);
  assert.throws(() => createCorePeople({}), /needs a database/);
  assert.deepEqual(metadata.dependencies, { '@engine9/interfaces/person': '>=1.7.0' });
  ok('an address is normalized and hashed the way core does, and the plugin declares the person interface it relies on');
}

console.log('unsubscribing');
{
  const core = coreDb(); const people = createCorePeople({ db: core.db });
  const a = core.person(); await core.email(a, 'ada@example.com', 'Subscribed'); await core.email(a, ' ADA@example.com ', 'Not Subscribed');
  const b = core.person(); await core.email(b, 'bo@example.com', 'Subscribed'); await core.email(b, 'hash@example.com', 'Subscribed', { noText: true });
  await core.email(core.person(), 'spam@example.com', 'Spam'); await core.email(core.person(), 'bounce@example.com', 'Bouncing');
  assert.equal(await people.unsubscribe('Ada@Example.com'), 2, 'every matching row, either spelling');
  assert.deepEqual(core.rows().map((r) => r.s), ['Unsubscribed', 'Unsubscribed', 'Subscribed', 'Subscribed', 'Spam', 'Bouncing']);
  assert.equal(await people.unsubscribe('hash@example.com'), 1, 'a row known only by core\'s hash is found');
  assert.equal(await people.unsubscribe('ada@example.com'), 0, 'idempotent');
  assert.equal(await people.unsubscribe('stranger@example.com'), 0); assert.equal(core.rows().length, 6, 'it never creates a row'); assert.equal(core.people(), 4, 'or a person');
  for (const bad of ['', 'nope', null, '{{ x }}']) assert.equal(await people.unsubscribe(bad), 0);
  ok('an unsubscribe marks every matching address Unsubscribed, only updates what core already has, and is safe to repeat');
}

console.log('subscribing');
{
  const core = coreDb(); const people = createCorePeople({ db: core.db });
  const fresh = await people.subscribe({ email: ' New@Example.com ', first: 'Nia', last: 'Ray' });
  assert.deepEqual([fresh.created, fresh.status], [true, 'Subscribed']);
  assert.deepEqual(core.rows().map((r) => [r.email, r.s, r.g, r.f]), [['new@example.com', 'Subscribed', 'Nia', 'Ray']], 'a person and an address, in core\'s standard tables');
  const again = await people.subscribe({ email: 'new@example.com', first: 'Other' });
  assert.deepEqual([again.created, again.personId === fresh.personId, core.people()], [false, true, 1], 'no second person');
  assert.equal(core.rows()[0].g, 'Nia', 'a name already there is never overwritten');
  const c = core.person(); await core.email(c, 'held@example.com', 'Not Subscribed');
  assert.equal((await people.subscribe({ email: 'held@example.com', first: 'Hal' })).status, 'Subscribed');
  assert.deepEqual(core.rows().find((r) => r.email === 'held@example.com').g, 'Hal', 'a missing name is filled in');
  for (const st of ['Unsubscribed', 'Bouncing', 'Spam']) {
    const p = core.person(); await core.email(p, `${st.toLowerCase()}@example.com`, st);
    assert.equal((await people.subscribe({ email: `${st.toLowerCase()}@example.com` })).status, st, `${st} is never changed`);
  }
  assert.equal(await people.subscribe({ email: 'nope' }), null);
  ok('a subscribe creates the person and the address if core has neither, fills in only what is missing, and never puts back anyone who left or bounces');
}

console.log('in the hub');
{
  const NOW = Date.UTC(2026, 9, 1);
  const core = coreDb(); const people = createCorePeople({ db: core.db });
  const provider = createMemoryProvider().seed({ contacts: [{ email: 'ada@example.com' }, { email: 'bo@example.com' }] });
  const a = core.person(); await core.email(a, 'ada@example.com', 'Subscribed'); await core.email(core.person(), 'bo@example.com', 'Subscribed');
  const hub = createEmailHub({ provider, brand: {}, people, now: () => NOW });
  const call = (m, p, b) => hub.handle(new Request('https://x' + p, { method: m, ...(b ? { body: JSON.stringify(b) } : {}) }), p.split('?')[0], m).then(async (r) => ({ status: r.status, body: await r.json() }));
  const st = () => Object.fromEntries(core.rows().map((r) => [r.email, r.s]));

  assert.equal((await hub.unsubscribe({ email: 'ADA@example.com' })).status, 200);
  assert.deepEqual([st()['ada@example.com'], st()['bo@example.com']], ['Unsubscribed', 'Subscribed'], 'the public unsubscribe route tells core');
  assert.equal((await hub.unsubscribe({ email: 'bo@example.com', company: 'bot' })).body.ok, true); assert.equal(st()['bo@example.com'], 'Subscribed', 'a honeypot hit changes nothing anywhere');
  const bo = (await call('GET', '/contacts?email=bo@example.com')).body.contacts[0];
  assert.equal((await call('POST', `/contacts/${bo.id}/unsubscribe`)).status, 200);
  assert.equal(st()['bo@example.com'], 'Unsubscribed', 'so does the Unsubscribe button on a contact');

  assert.equal((await call('POST', '/contacts', { email: 'new@example.com', first: 'Nia', consent: true })).status, 200);
  assert.equal(st()['new@example.com'], 'Subscribed', 'adding someone with the consent tick records it in core');
  assert.equal((await call('POST', '/contacts', { email: 'x@example.com', first: 'X', consent: false })).status, 400); assert.equal(st()['x@example.com'], undefined, 'no consent, no record');
  const again = await call('POST', '/contacts', { email: 'ada@example.com', consent: true });
  assert.match(again.body.note, /stay unsubscribed/); assert.equal(st()['ada@example.com'], 'Unsubscribed', 'somebody who left stays gone in core too');
  ok('the hub tells core when someone leaves or is added, and never when the service kept someone unsubscribed or consent was not given');
}
{
  const core = coreDb();
  const broken = { unsubscribe: async () => { throw new Error('core unavailable'); }, subscribe: async () => { throw new Error('core unavailable'); } };
  const provider = createMemoryProvider().seed({ contacts: [{ email: 'ada@example.com' }] });
  const hub = createEmailHub({ provider, brand: {}, people: broken });
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const r = await hub.unsubscribe({ email: 'ada@example.com' });
    assert.deepEqual([r.status, r.body.ok], [200, true], 'the service accepted it, so the person is unsubscribed');
    assert.equal((await provider.listContacts({ status: 'unsubscribed' })).total, 1);
    const add = await hub.handle(new Request('https://x/contacts', { method: 'POST', body: JSON.stringify({ email: 'z@example.com', consent: true }) }), '/contacts', 'POST');
    assert.equal(add.status, 200);
    assert.ok(errs.length >= 2 && errs.every((e) => !e.includes('@example.com')), 'the failure is logged, without the address');
    assert.equal(await quietly(async () => { throw new Error('x'); }), null);
  } finally { console.error = orig; }
  // without a `people`, nothing changes for a host that has none
  const plain = createEmailHub({ provider: createMemoryProvider().seed({ contacts: [{ email: 'q@example.com' }] }), brand: {} });
  assert.equal((await plain.unsubscribe({ email: 'q@example.com' })).status, 200);
  assert.equal((await handleUnsubscribe({ unsubscribeByEmail: async () => {}, connected: () => true }, { email: 'a@b.co' }, { people: null })).status, 200);
  void core;
  ok('a failure in core never undoes or hides what the service accepted, is logged without the address, and a host with no `people` is unchanged');
}
console.log(`\n${n} passed`);
