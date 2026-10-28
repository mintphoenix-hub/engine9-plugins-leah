// A layout can offer a select field and say where replies go (for example, a department's inbox).
import assert from 'node:assert/strict';
import { checkLayouts, cleanValues, listLayouts, replyToOf } from './layouts.js';
import { createEmailHub } from './routes.js';
import { createMemoryProvider } from './adapters/memory.js';

const ok = (m) => console.log(`  ok  ${m}`);
const layout = {
  label: 'Note', description: '',
  fields: [
    { key: 'dept', label: 'Replies go to', type: 'select', required: true, options: [{ value: 'a', label: 'Department A' }, { value: 'b', label: 'Department B' }] },
    { key: 'message', label: 'Message', type: 'longtext', required: true },
  ],
  replyTo: (v) => ({ a: 'a@example.org', b: 'b@example.org' })[v.dept] || '',
  render: (v, ctx) => `<p>${v.message}</p><a href="${ctx.mergeTags.unsubscribe}">Unsubscribe</a>`,
};
checkLayouts({ note: layout });
assert.throws(() => checkLayouts({ bad: { ...layout, fields: [{ key: 'x', type: 'select' }] } }));
ok('a select needs options');
assert.deepEqual(listLayouts({ note: layout })[0].fields[0].options.map((o) => o.value), ['a', 'b']);
ok('the screens are told the choices');
assert.equal(cleanValues(layout, { dept: 'a', message: 'Hi' }).dept, 'a');
assert.throws(() => cleanValues(layout, { dept: 'zzz', message: 'Hi' }), /choose one/);
assert.equal(cleanValues(layout, { dept: 'zzz' }, { partial: true }).dept, '');
ok('only a listed choice is kept');
assert.equal(replyToOf(layout, { dept: 'b' }), 'b@example.org');
assert.equal(replyToOf(layout, { dept: '' }), '');
assert.equal(replyToOf({ replyTo: () => 'not an address' }, {}), '');
ok('replyTo gives a plain address or nothing');

const provider = createMemoryProvider();
const store = { saveLayout: async () => {}, getLayout: async () => null, logos: async () => [], loadStyle: async () => null };
let seen;
const orig = provider.createCampaign;
provider.createCampaign = async (i) => { seen = i; return orig(i); };
const hub = createEmailHub({ provider, layouts: { note: layout }, store, brand: { name: 'X', style: {} } });
const res = await hub.handle(new Request('https://x.test/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: 'note', values: { dept: 'b', message: 'Hello' }, subject: 'Hi', to: '' }) }), '/campaigns', 'POST');
assert.equal(res.status, 200);
assert.equal(seen.replyTo, 'b@example.org');
ok('creating an email from the layout passes the department\'s address to the service');
console.log('5 passed');
