import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createEmailHub } from './routes.js';
import { createMemoryProvider } from './adapters/memory.js';
import { createKitProvider } from './adapters/kit.js';
import { createMailchimpProvider } from './adapters/mailchimp.js';
import { createD1Store } from './store.js';
import { emailShell, checkStyle, bodyHtml, StyleError, DEFAULT_STYLE } from './shell.js';
import { planSchedule, scheduleRules, DEFAULT_SCHEDULE } from './schedule.js';
import { capabilitiesOf, HubError } from './provider.js';
import schema from './schema.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const call = (hub, method, path, body) => hub.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, method).then(async (r) => ({ status: r.status, body: await r.json() }));

console.log('the body font');
{
  const sans = emailShell('x', {});
  assert.ok(sans.includes("'Helvetica Neue'") && !sans.includes('Georgia'));
  const serif = emailShell('x', { style: { font: 'serif' } });
  assert.ok(serif.includes("font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.65") && !serif.includes("'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px"));
  assert.equal(DEFAULT_STYLE.font, 'sans');
  assert.equal(checkStyle({ font: 'serif' }, {}).font, 'serif');
  assert.equal(checkStyle({}, { style: { font: 'serif' } }).font, 'serif', 'a host can make serif its default');
  for (const bad of ['comic', '', 'serif; x', null, 7]) assert.throws(() => checkStyle({ font: bad }, {}), StyleError, String(bad));
  assert.ok(bodyHtml('hi', { style: checkStyle({ font: 'serif' }, {}) }).includes('Georgia'));
  ok('the words are sans by default; serif is one setting, from the brand or the look editor, and nothing else is accepted');
}

console.log('scheduling rules a host may loosen');
{
  const inMinutes = (m) => new Date(NOW + m * 60000).toISOString();
  assert.deepEqual(DEFAULT_SCHEDULE, { leadMinutes: 15, stepMinutes: 15 });
  assert.deepEqual(scheduleRules(), DEFAULT_SCHEDULE); assert.deepEqual(scheduleRules({ leadMinutes: 0, stepMinutes: -3 }), DEFAULT_SCHEDULE); assert.deepEqual(scheduleRules({ leadMinutes: 99999, stepMinutes: 999 }), { leadMinutes: 1440, stepMinutes: 60 });
  assert.throws(() => planSchedule(inMinutes(0), true, NOW), /at least 15 minutes/);
  assert.equal(planSchedule(inMinutes(16), true, NOW).at, NOW + 30 * 60000, 'default: rounds up to the quarter hour');
  const loose = { leadMinutes: 5, stepMinutes: 1 };
  assert.equal(planSchedule(inMinutes(7), true, NOW, loose).at, NOW + 7 * 60000);
  assert.throws(() => planSchedule(inMinutes(3), true, NOW, loose), /at least 5 minutes/);
  assert.throws(() => planSchedule(inMinutes(60), false, NOW, loose), /Tick the box/);
  const hub = createEmailHub({ provider: createMemoryProvider(), brand: {}, now: () => NOW, schedule: loose });
  const id = (await call(hub, 'POST', '/campaigns', { subject: 'S', text: 'T' })).body.campaign.id;
  assert.equal((await call(hub, 'POST', `/campaigns/${id}/schedule`, { sendAt: inMinutes(3), confirm: true })).status, 400);
  const sched = await call(hub, 'POST', `/campaigns/${id}/schedule`, { sendAt: inMinutes(7), confirm: true });
  assert.deepEqual([sched.status, sched.body.scheduledFor], [200, new Date(NOW + 7 * 60000).toISOString().replace(/\.\d+Z$/, 'Z')]);
  assert.deepEqual((await call(hub, 'GET', '/config')).body.schedule, loose);
  assert.deepEqual((await call(createEmailHub({ provider: createMemoryProvider(), brand: {} }), 'GET', '/config')).body.schedule, DEFAULT_SCHEDULE);
  ok('the lead time and the step are the host\'s to loosen (never under a minute), default to 15 and 15, and are told to the screens');
}

console.log('templates and contact history');
{
  const kitFetch = (routes) => async (url, init = {}) => {
    const path = String(url).replace('https://api.kit.com/v4', '').split('?')[0];
    const out = routes[`${init.method || 'GET'} ${path}`];
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(out ?? {}) };
  };
  const kit = createKitProvider({ apiKey: 'kit_x', fetch: kitFetch({
    'GET /email_templates': { email_templates: [{ id: 1, name: 'House', is_default: true }, { id: 2, name: 'Plain' }] },
    'GET /subscribers/9': { subscriber: { id: 9, email_address: 'a@b.co', state: 'active', fields: { moved_signup: '2022-12-09', moved_source: 'Admin Add', signup_date: 'x' } } },
    'GET /subscribers/9/tags': { tags: [{ id: 3, name: 'website' }] },
  }), fields: { joined: 'moved_signup', source: 'moved_source' } });
  assert.equal(capabilitiesOf(kit).templates, true);
  assert.deepEqual((await kit.listTemplates()).templates, [{ id: '1', name: 'House', isDefault: true }, { id: '2', name: 'Plain', isDefault: false }]);
  const c = await kit.contact('9'); assert.deepEqual([c.joined, c.source, c.tags[0].name], ['2022-12-09', 'Admin Add', 'website']);
  const plain = createKitProvider({ apiKey: 'kit_x', fetch: kitFetch({ 'GET /subscribers/9': { subscriber: { id: 9, email_address: 'a@b.co', fields: { signup_date: '2020-01-01' } } } }) });
  assert.equal((await plain.contact('9')).joined, '2020-01-01', 'no configured field: the neutral default');
  const hub = createEmailHub({ provider: kit, brand: {} });
  const t = await call(hub, 'GET', '/templates'); assert.deepEqual([t.status, t.body.templates.length], [200, 2]);
  assert.equal((await call(createEmailHub({ provider: createMemoryProvider(), brand: {} }), 'GET', '/templates')).status, 405, 'a provider with none says so');
  assert.equal(capabilitiesOf(createMailchimpProvider({ apiKey: 'a'.repeat(32) + '-us1', listId: 'L' })).templates, true);
  ok('templates are listed by name where the service offers them, and a person\'s original signup date and source come from the fields the host names');
}

console.log('the font is saved with the look');
{
  const TYPE = { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', id_uuid: 'TEXT PRIMARY KEY', created_at: "TEXT DEFAULT (datetime('now'))", modified_at: "TEXT DEFAULT (datetime('now'))", int: 'INTEGER', double: 'REAL' };
  const raw = new Database(':memory:');
  for (const t of schema.tables) raw.exec(`CREATE TABLE ${t.name} (${Object.entries(t.columns).map(([c, d]) => `${c} ${TYPE[typeof d === 'string' ? d : d.type] || 'TEXT'}`).join(', ')})`);
  raw.exec('CREATE UNIQUE INDEX s ON engine9_email_hub_style (slug)');
  const run = (st, a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => st.run(...a) });
  const db = { prepare: (sql) => { const st = raw.prepare(sql); return { ...run(st, []), bind: (...a) => run(st, a) }; } };
  const store = createD1Store({ db, publicLogoBase: 'https://example.org/e/' });
  const hub = createEmailHub({ provider: createMemoryProvider(), brand: { style: { font: 'serif' } }, store });
  assert.equal((await call(hub, 'GET', '/look')).body.style.font, 'serif', 'the brand default');
  assert.equal((await call(hub, 'PATCH', '/look', { font: 'sans' })).status, 200);
  assert.equal((await call(hub, 'GET', '/look')).body.style.font, 'sans', 'saved and read back');
  assert.equal((await call(hub, 'PATCH', '/look', { font: 'wingdings' })).status, 400);
  assert.equal((await call(hub, 'PATCH', '/look', { reset: true })).status, 200); assert.equal((await call(hub, 'GET', '/look')).body.style.font, 'serif', 'reset goes back to the brand default');
  ok('the font is stored in the look, refused when it is not one of the two, and reset returns the brand\'s default');
}
console.log(`\n${n} passed`);
