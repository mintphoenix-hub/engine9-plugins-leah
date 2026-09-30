import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import schema from './schema.js';
import { createD1Store } from './store.js';
import { createEmailHub } from './routes.js';
import { createMemoryProvider } from './adapters/memory.js';
import { createKitProvider } from './adapters/kit.js';
import { checkLayouts, cleanValues, listLayouts } from './layouts.js';
import { capabilitiesOf } from './provider.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const TYPE = { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', id_uuid: 'TEXT PRIMARY KEY', created_at: "TEXT DEFAULT (datetime('now'))", modified_at: "TEXT DEFAULT (datetime('now'))", string: 'TEXT', text: 'TEXT', int: 'INTEGER', double: 'REAL', datetime: 'TEXT' };
function open() {
  const raw = new Database(':memory:');
  for (const t of schema.tables) {
    const cols = Object.entries(t.columns).map(([c, d]) => `${c} ${TYPE[typeof d === 'string' ? d : d.type] || 'TEXT'}${d.nullable === false && d.type !== 'id' ? ' NOT NULL' : ''}`);
    raw.exec(`CREATE TABLE ${t.name} (${cols.join(', ')})`);
    for (const ix of t.indexes || []) if (ix.unique) raw.exec(`CREATE UNIQUE INDEX ${t.name}_${ix.columns.join('_')} ON ${t.name} (${ix.columns.join(', ')})`);
  }
  const run = (st, a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => st.run(...a) });
  return { prepare: (sql) => { const st = raw.prepare(sql); return { ...run(st, []), bind: (...a) => run(st, a) }; } };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SHOW = {
  label: 'New show', description: 'The show announcement.',
  fields: [
    { key: 'title', label: 'Show title', type: 'text', required: true },
    { key: 'story', label: 'Story', type: 'longtext' },
    { key: 'ticketUrl', label: 'Ticket link', type: 'url' }
  ],
  render: (v, { mergeTags }) => `<html><body><h1>${esc(v.title)}</h1><p>${esc(v.story)}</p><a href="${esc(v.ticketUrl)}">Tickets</a><p>${mergeTags.address}</p><a href="${mergeTags.unsubscribe}">Unsubscribe</a></body></html>`
};
const call = (hub, method, path, body) => hub.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, method).then(async (r) => ({ status: r.status, body: await r.json() }));

console.log('layouts');
{
  assert.throws(() => checkLayouts({ 'Bad Id': SHOW }), /layout id/); ok('a bad layout id is refused');
  assert.throws(() => checkLayouts({ show: { ...SHOW, fields: [{ key: 'a' }, { key: 'a' }] } }), /repeated/); ok('a repeated field is refused');
  assert.throws(() => checkLayouts({ show: { label: 'x', fields: [] } }), /render/); ok('a layout with no render is refused');
  const v = cleanValues(SHOW, { title: '  Cluelesque  ', story: 'One\r\n\r\nTwo', ticketUrl: 'https://tix.example/x', extra: 'nope' });
  assert.deepEqual(v, { title: 'Cluelesque', story: 'One\n\nTwo', ticketUrl: 'https://tix.example/x' }); ok('only declared fields, tidied');
  assert.throws(() => cleanValues(SHOW, { title: '' }), /needed/); ok('a required field must be filled');
  assert.throws(() => cleanValues(SHOW, { title: 'x', ticketUrl: 'http://tix.example' }), /https/); ok('a link must be https');
  assert.equal(cleanValues(SHOW, { title: '', ticketUrl: 'javascript:alert(1)' }, { partial: true }).ticketUrl, ''); ok('a half-filled form previews without complaint');
  const PICS = { label: 'With a picture', fields: [{ key: 'title', label: 'Title', required: true }, { key: 'banner', label: 'Banner picture', type: 'image' }], render: () => '<html></html>' };
  checkLayouts({ pics: PICS }); ok('a picture field is a valid field type');
  assert.equal(cleanValues(PICS, { title: 'x', banner: 'https://cdn.example/a.jpg' }).banner, 'https://cdn.example/a.jpg'); ok('a picture address is kept');
  assert.throws(() => cleanValues(PICS, { title: 'x', banner: 'http://cdn.example/a.jpg' }), /https/); ok('a picture must be https');
  assert.equal(cleanValues(PICS, { title: 'x', banner: 'javascript:alert(1)' }, { partial: true }).banner, ''); ok('a script address is never kept as a picture');
  assert.equal(cleanValues(PICS, { title: 'x', banner: 'data:image/png;base64,AAAA' }, { partial: true }).banner, ''); ok('an embedded picture is not accepted, only an address');
  assert.equal(listLayouts({ pics: PICS })[0].fields[1].type, 'image'); ok('the screens are told a field is a picture');
  assert.ok(listLayouts({ show: SHOW })[0].fields.every((f) => !('render' in f)) && !('render' in listLayouts({ show: SHOW })[0])); ok('the screens are never given the render function');
  assert.deepEqual(listLayouts({ show: { ...SHOW, sample: { title: 'Sample' } } })[0].sample, { title: 'Sample' }); assert.equal(listLayouts({ show: SHOW })[0].sample, null); ok('a layout may carry a sample, for previewing it as a template');
}

console.log('creating, editing and duplicating');
{
  const store = createD1Store({ db: open() });
  const provider = createMemoryProvider();
  const hub = createEmailHub({ provider, store, layouts: { show: SHOW }, brand: { address: '1 Main St' } });
  const list = await call(hub, 'GET', '/layouts');
  assert.equal(list.body.enabled, true); assert.equal(list.body.layouts[0].id, 'show'); ok('the layouts are offered');
  const pv = await call(hub, 'POST', '/layouts/show/render', { values: { title: 'Half <b>filled</b>' } });
  assert.ok(pv.body.html.includes('Half &lt;b&gt;filled&lt;/b&gt;') && !/\{\{/.test(pv.body.html)); ok('a live preview escapes what was typed');
  const bad = await call(hub, 'POST', '/campaigns', { subject: 'S', layout: 'show', values: { title: '' } });
  assert.equal(bad.status, 400); ok('a required field stops the save');
  const made = await call(hub, 'POST', '/campaigns', { subject: 'Cluelesque is back', layout: 'show', values: { title: 'Cluelesque', story: 'Murder!', ticketUrl: 'https://tix.example/c' } });
  assert.equal(made.status, 200); const id = made.body.campaign.id;
  const content = await call(hub, 'GET', `/campaigns/${id}/content`);
  assert.ok(content.body.html.includes('<h1>Cluelesque</h1>')); ok('the email is made from the fields');
  const got = await call(hub, 'GET', `/campaigns/${id}/layout`);
  assert.equal(got.body.layout, 'show'); assert.equal(got.body.values.title, 'Cluelesque'); ok('the fields come back for editing');
  const upd = await call(hub, 'PATCH', `/campaigns/${id}`, { layoutValues: { title: 'Cluelesque 2', story: 'More murder.', ticketUrl: 'https://tix.example/c2' } });
  assert.equal(upd.status, 200);
  assert.ok((await call(hub, 'GET', `/campaigns/${id}/content`)).body.html.includes('<h1>Cluelesque 2</h1>')); ok('editing the fields re-makes the whole email');
  const dup = await call(hub, 'POST', `/campaigns/${id}/duplicate`);
  const dupId = dup.body.campaign.id;
  assert.notEqual(dupId, id);
  const dupLay = await call(hub, 'GET', `/campaigns/${dupId}/layout`);
  assert.equal(dupLay.body.values.title, 'Cluelesque 2'); ok('a duplicate keeps the fields, so it can be changed by editing them');
  await call(hub, 'PATCH', `/campaigns/${dupId}`, { layoutValues: { title: 'Next show', story: '', ticketUrl: '' } });
  assert.equal((await call(hub, 'GET', `/campaigns/${id}/layout`)).body.values.title, 'Cluelesque 2'); ok('changing the copy leaves the original alone');
  const plain = await call(hub, 'POST', '/campaigns', { subject: 'Plain', text: 'Hello there' });
  assert.equal((await call(hub, 'GET', `/campaigns/${plain.body.campaign.id}/layout`)).body.layout, null); ok('an ordinary email has no fields');
  assert.equal((await call(hub, 'PATCH', `/campaigns/${plain.body.campaign.id}`, { layoutValues: { title: 'x' } })).status, 409); ok('and its fields cannot be edited');
  await call(hub, 'DELETE', `/campaigns/${dupId}`);
  assert.equal((await call(hub, 'GET', `/campaigns/${dupId}/layout`)).body.layout, null); ok('deleting a draft forgets its fields');
}

console.log('off unless it can work');
{
  const noStore = createEmailHub({ provider: createMemoryProvider(), layouts: { show: SHOW } });
  assert.equal((await call(noStore, 'GET', '/layouts')).body.enabled, false); ok('with no store the layouts are not offered');
  const none = createEmailHub({ provider: createMemoryProvider(), store: createD1Store({ db: open() }) });
  assert.equal((await call(none, 'GET', '/layouts')).body.enabled, false); ok('with no layouts nothing changes');
  const sent = createEmailHub({ provider: createMemoryProvider(), store: createD1Store({ db: open() }), layouts: { show: { ...SHOW, render: () => '<p>No unsubscribe here</p>' } } });
  assert.notEqual((await call(sent, 'POST', '/campaigns', { subject: 'S', layout: 'show', values: { title: 'T' } })).status, 200); ok('a layout that forgets the unsubscribe link cannot be saved');
}

console.log('suggested copy from the host\'s own data');
{
  const rows = { a: { title: 'Cluelesque', story: 'A murder.\r\n\r\nMore.', ticketUrl: 'http://not-https.example', secret: 'never', subject: 'Get your detective on', previewText: 'Two shows only' }, b: null };
  const withSource = { ...SHOW, source: { label: 'Pull copy from a show', list: async () => [{ id: 'a', label: 'Cluelesque', note: 'next' }, { id: 'b', label: 'Gone' }], get: async (id) => (rows[id] ? { values: rows[id], subject: rows[id].subject, previewText: rows[id].previewText } : null) } };
  const hub = createEmailHub({ provider: createMemoryProvider(), store: createD1Store({ db: open() }), layouts: { show: withSource } });
  const list = await call(hub, 'GET', '/layouts');
  assert.deepEqual(list.body.layouts[0].source, { label: 'Pull copy from a show' }); ok('a layout says it can pull copy, and the screens are never given the functions');
  const choices = await call(hub, 'GET', '/layouts/show/source');
  assert.equal(choices.status, 200); assert.deepEqual(choices.body.items.map((i) => [i.id, i.label, i.note]), [['a', 'Cluelesque', 'next'], ['b', 'Gone', '']]); ok('the choices come from the host');
  const one = await call(hub, 'GET', '/layouts/show/source/a');
  assert.equal(one.status, 200);
  assert.equal(one.body.values.title, 'Cluelesque'); assert.equal(one.body.values.story, 'A murder.\n\nMore.'); ok('the suggested values come back tidied');
  assert.equal(one.body.values.ticketUrl, ''); assert.equal('secret' in one.body.values, false); ok('a link that is not https is dropped, and fields the layout does not declare never get through');
  assert.equal(one.body.subject, 'Get your detective on'); assert.equal(one.body.previewText, 'Two shows only'); ok('a subject and preview line can be suggested too');
  assert.equal((await call(hub, 'GET', '/layouts/show/source/b')).status, 404); ok('one that is not there is a 404');
  const plain = createEmailHub({ provider: createMemoryProvider(), store: createD1Store({ db: open() }), layouts: { show: SHOW } });
  assert.equal((await call(plain, 'GET', '/layouts/show/source')).status, 404); assert.equal((await call(plain, 'GET', '/layouts')).body.layouts[0].source, null); ok('a layout with no source offers nothing');
  assert.equal((await call(hub, 'POST', '/layouts/show/source', { x: 1 })).status, 405); ok('it is read-only');
}

console.log('Kit keeps the design');
{
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.kit.com/v4', ''), method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method, body });
    const out = (o) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(o) });
    if (method === 'GET' && /^\/broadcasts\/9$/.test(path)) return out({ broadcast: { id: 9, subject: 'S', preview_text: 'P', description: 'D', content: '<p>x</p>', email_template: { id: 5564602, name: 'Design' }, subscriber_filter: [] } });
    if (method === 'POST' && path === '/broadcasts') return out({ broadcast: { id: 10, ...body } });
    if (method === 'PUT') return out({ broadcast: { id: 9, ...body } });
    return out({});
  };
  const kit = createKitProvider({ apiKey: 'kit_secretkey123', fetch });
  await kit.duplicateCampaign('9');
  const dup = calls.find((c) => c.method === 'POST' && c.path === '/broadcasts');
  assert.equal(dup.body.email_template_id, 5564602); ok('a duplicate is sent in the same template as the original');
  await kit.createCampaign({ subject: 'S', html: '<p>x</p>', to: {}, templateId: '777' });
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/broadcasts').pop().body.email_template_id, 777); ok('a new email can name the template it is sent in');
  await kit.createCampaign({ subject: 'S', html: '<p>x</p>', to: {} });
  assert.equal('email_template_id' in calls.filter((c) => c.method === 'POST' && c.path === '/broadcasts').pop().body, false); ok('and otherwise Kit picks its default');
  await kit.updateCampaign('9', { html: '<p>new</p>' });
  assert.equal(calls.filter((c) => c.method === 'PUT').pop().body.content, '<p>new</p>'); ok('the body of a draft can be replaced');
  assert.equal(capabilitiesOf(kit).layouts, true); assert.equal(capabilitiesOf(createMemoryProvider()).layouts, true); ok('Kit and the memory provider can take layouts');
}

console.log(`\n${n} passed`);
