import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import schema from './schema.js';
import { createD1Store } from './store.js';
import { createEmailHub } from './routes.js';
import { createMemoryProvider } from './adapters/memory.js';
import { createMailchimpProvider } from './adapters/mailchimp.js';
import { fakeMailchimp } from './fake-mailchimp.mjs';
import { tableNames } from './helpers.js';
import { sniffImage, LOGO_FILE } from './logos.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };

/* The tables are built FROM schema.js, so the test cannot drift from what core deploys. */
const TYPE = { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', id_uuid: 'TEXT PRIMARY KEY', created_at: "TEXT DEFAULT (datetime('now'))", modified_at: "TEXT DEFAULT (datetime('now'))", int: 'INTEGER', double: 'REAL' };
function open() {
  const raw = new Database(':memory:');
  for (const t of schema.tables) {
    const cols = Object.entries(t.columns).map(([c, d]) => `${c} ${TYPE[typeof d === 'string' ? d : d.type] || 'TEXT'}${d.nullable === false && d.type !== 'id' ? ' NOT NULL' : ''}`);
    raw.exec(`CREATE TABLE ${t.name} (${cols.join(', ')})`);
    for (const ix of t.indexes || []) if (ix.unique) raw.exec(`CREATE UNIQUE INDEX ${t.name}_${ix.columns.join('_')} ON ${t.name} (${ix.columns.join(', ')})`);
  }
  const run = (st, a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => st.run(...a) });
  const db = { prepare: (sql) => { const st = raw.prepare(sql); return { ...run(st, []), bind: (...a) => run(st, a) }; } };
  return db;
}
const bucket = () => {
  const m = new Map();
  return { m, put: async (k, stream) => { m.set(k, new Uint8Array(await new Response(stream).arrayBuffer())); }, get: async (k) => (m.has(k) ? { body: m.get(k), size: m.get(k).length, writeHttpMetadata: (h) => h.set('Content-Type', 'image/png') } : null), delete: async (k) => { m.delete(k); } };
};
const BASE = 'https://example.org/email-assets/';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const png = (name = 'logo.png') => new File([PNG], name, { type: 'image/png' });
const BUILT = [{ id: 'b1', name: 'Wordmark', url: 'https://example.org/assets/wordmark.png' }];
const call = (hub, method, path, body, form) => hub.handle(new Request('https://x' + path, { method, ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}) }), path, method).then(async (r) => ({ status: r.status, body: await r.json() }));

console.log('the database store');
{
  assert.deepEqual(Object.keys(tableNames()), ['style', 'logo', 'archive']); assert.ok(Object.values(tableNames()).every((t) => t.startsWith('engine9_email_hub_')));
  const T = tableNames();
  const db = open(), images = bucket();
  const store = createD1Store({ db, images, publicLogoBase: BASE, builtIn: BUILT });
  const brand = { name: 'Example', style: { logoUrl: BUILT[0].url }, isLogoUrl: store.isLogoUrl };
  const hub = createEmailHub({ provider: createMemoryProvider(), brand, store });

  const fresh = await call(hub, 'GET', '/look'); assert.equal(fresh.body.style.logoUrl, BUILT[0].url); assert.equal(fresh.body.logos.length, 1); assert.equal(fresh.body.logos[0].builtin, true);
  const form = new FormData(); form.append('file', png('My Logo.png')); form.append('name', 'My Logo.png');
  const up = await call(hub, 'POST', '/look/logos', null, form); assert.equal(up.status, 200); const logo = up.body.logo;
  assert.deepEqual([logo.name, logo.builtin, logo.url.startsWith(BASE), LOGO_FILE.test(logo.url.slice(BASE.length))], ['My Logo', false, true, true]);
  assert.equal((await call(hub, 'GET', '/look')).body.logos.length, 2);
  assert.equal(images.m.size, 1); ok('a logo is uploaded through the hub, stored under email-logos/, and listed after the built-in ones');

  const saved = await call(hub, 'PATCH', '/look', { logoUrl: logo.url, ground: '#101010', footerLine: 'Hello', logoWidth: 180 });
  assert.equal(saved.status, 200); const again = (await call(hub, 'GET', '/look')).body.style;
  assert.deepEqual([again.logoUrl, again.ground, again.footerLine, again.logoWidth], [logo.url, '#101010', 'Hello', 180]);
  assert.equal((await call(hub, 'PATCH', '/look', { logoUrl: 'https://evil.example/x.png' })).status, 400); ok('the look is saved to the table and read back; a logo from anywhere else is refused');

  const file = logo.url.slice(BASE.length);
  const served = await store.serveLogo(file); assert.equal(served.status, 200); assert.equal(served.headers.get('x-content-type-options'), 'nosniff'); assert.match(served.headers.get('cache-control'), /immutable/);
  for (const bad of ['../x.png', 'a.png', '', 'email-logos/' + file, file + '.exe']) assert.equal((await store.serveLogo(bad)).status, 404, bad);
  images.m.set('secret/file.png', new Uint8Array(1)); assert.equal((await store.serveLogo('secret%2Ffile.png')).status, 404); ok('only files the store made are served, by exact name, with nosniff');

  const noImg = new FormData(); noImg.append('file', new File(['<svg onload=1/>'], 'x.png', { type: 'image/png' }));
  assert.match((await call(hub, 'POST', '/look/logos', null, noImg)).body.error, /PNG, JPEG/);
  const big = new FormData(); big.append('file', new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png'));
  assert.match((await call(hub, 'POST', '/look/logos', null, big)).body.error, /over 2 MB/);
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a')), 'image/gif'); assert.equal(sniffImage(new TextEncoder().encode('<svg')), null); ok('uploads are checked by their first bytes and size, not their name');

  const del = await call(hub, 'DELETE', `/look/logos/${logo.id}`);
  assert.equal(del.status, 200); assert.equal(del.body.style.logoUrl, BUILT[0].url, 'the default logo is back'); assert.equal(images.m.size, 1, 'the uploaded bytes are gone (only the unrelated test object is left)');
  assert.equal((await call(hub, 'DELETE', `/look/logos/${logo.id}`)).status, 404); ok('deleting a logo the look uses puts the default back and removes the bytes');

  const reset = await call(hub, 'PATCH', '/look', { reset: true }); assert.equal(reset.status, 200); assert.equal((await store.loadStyle()), null); ok('reset puts the original look back');
  assert.equal((await db.prepare(`SELECT COUNT(*) AS c FROM ${T.style}`).first()).c, 0, 'no row is left behind');
}

console.log('the archive');
{
  const db = open(), store = createD1Store({ db, publicLogoBase: BASE });
  const hub = createEmailHub({ provider: createMailchimpProvider({ apiKey: '', listId: '' }), brand: {}, store });   // the provider is NOT connected
  await store.saveArchived({ source: 'mailchimp', id: 'c1', subject: 'Old', sentAt: '2025-01-02T03:04:05Z', emailsSent: 100, openRate: 18.9, html: '<p>old</p>' });
  await store.saveArchived({ source: 'mailchimp', id: 'c1', subject: 'Old (edited)', sentAt: '2025-01-02T03:04:05Z', emailsSent: 100, openRate: 18.9, html: '<p>old</p>' });
  await store.saveArchived({ source: 'mailchimp', id: 'c2', subject: 'Newer', sentAt: '2025-06-01T00:00:00Z', html: '<p>n</p>' });
  const list = await call(hub, 'GET', '/archive');
  assert.deepEqual(list.body.archive.map((r) => [r.id, r.subject]), [['c2', 'Newer'], ['c1', 'Old (edited)']], 'newest first, and saving twice updates rather than duplicates');
  assert.equal((await call(hub, 'GET', '/archive/mailchimp/c1/content')).body.html, '<p>old</p>');
  assert.equal((await call(hub, 'GET', '/archive/mailchimp/nope/content')).status, 404);
  ok('sent emails from a provider that is gone are kept, listed newest first and read even when the provider is not connected');
}

console.log('unsubscribing through the site, on Mailchimp');
{
  const fake = fakeMailchimp({ now: () => 0 });
  try {
    const provider = createMailchimpProvider({ apiKey: '0123456789abcdef0123456789abcdef-us12', listId: 'LIST1' });
    fake.addMember('ada@example.com'); fake.addMember('bo@example.com', { status: 'cleaned' }); fake.addMember('pat@example.com', { status: 'unsubscribed' });
    const hub = createEmailHub({ provider, brand: { unsubscribePage: 'https://example.org/#/unsubscribe' } });
    for (const e of ['ada@example.com', 'bo@example.com', 'pat@example.com', 'nobody@example.com']) assert.equal((await hub.unsubscribe({ email: e })).status, 200);
    const by = Object.fromEntries(fake.state.members.map((m) => [m.email_address, m.status]));
    assert.deepEqual(by, { 'ada@example.com': 'unsubscribed', 'bo@example.com': 'cleaned', 'pat@example.com': 'unsubscribed' });
    assert.equal(provider.mergeTags.email, '*|EMAIL|*');
    const d = await call(hub, 'POST', '/campaigns', { subject: 'S', text: 'T' });
    const html = fake.state.campaigns.get(d.body.campaign.id).html;
    assert.ok(html.includes('https://example.org/#/unsubscribe?e=*|EMAIL|*') && html.includes('*|UNSUB|*') && html.includes('Trouble unsubscribing?'));
    ok('on Mailchimp too: a subscribed person is cancelled, a bounced one is left, and the email carries the site link plus *|UNSUB|*');
  } finally { fake.restore(); }
}
console.log(`\n${n} passed`);
