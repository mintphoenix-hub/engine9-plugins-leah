import assert from 'node:assert/strict';
import { createEmailHubs } from './accounts.js';
import { createMemoryProvider } from './adapters/memory.js';
import { mountEmailHubs } from './ui/accounts.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const brand = (name) => ({ name, style: {}, isLogoUrl: () => false });
const make = () => createEmailHubs({
  now: () => NOW,
  accounts: {
    main: { label: 'Main list', provider: createMemoryProvider({ now: () => NOW }), brand: brand('Main') },
    other: { provider: createMemoryProvider({ now: () => NOW }), brand: brand('Other') },
  },
});
const call = async (hubs, method, path, body) => {
  const r = await hubs.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, method);
  return r && { status: r.status, body: await r.json() };
};

console.log('server: accounts');
{
  const hubs = make();
  assert.deepEqual(hubs.accounts, ['main', 'other']);
  const list = await call(hubs, 'GET', '/accounts');
  assert.deepEqual(list.body.accounts.map((a) => a.id), ['main', 'other']);
  assert.equal(list.body.accounts[0].label, 'Main list');
  assert.equal(list.body.accounts[1].label, 'Other', 'the label falls back to the brand name');
  assert.equal(list.body.accounts[0].connected, true);
  assert.equal((await call(hubs, 'POST', '/accounts')).status, 405);
  ok('lists the accounts, with a label, the service and whether it is connected');
}

console.log('server: each account is its own hub');
{
  const hubs = make();
  const made = await call(hubs, 'POST', '/main/campaigns', { subject: 'Hello main', previewText: 'Hi', text: 'Hello there.' });
  assert.equal(made.status, 200);
  const main = await call(hubs, 'GET', '/main/campaigns');
  const other = await call(hubs, 'GET', '/other/campaigns');
  assert.ok(main.body.campaigns.some((c) => c.subject === 'Hello main'));
  assert.ok(!other.body.campaigns.some((c) => c.subject === 'Hello main'), 'an email made in one account is not in the other');
  assert.equal((await call(hubs, 'GET', '/main/config')).body.brand.name, 'Main');
  assert.equal((await call(hubs, 'GET', '/other/config')).body.brand.name, 'Other');
  ok('routes go to the right account and nothing leaks between them');
}

console.log('server: what is not an account');
{
  const hubs = make();
  assert.equal(await call(hubs, 'GET', '/nope/campaigns'), null);
  assert.equal(await call(hubs, 'GET', '/'), null);
  assert.equal(await call(hubs, 'GET', '/main/not-a-route'), null);
  assert.equal(await call(hubs, 'GET', '/Main/campaigns'), null, 'ids are lower case');
  ok('anything that is not an account route is null, like a single hub');
}

console.log('server: setup is checked');
{
  const p = createMemoryProvider();
  assert.throws(() => createEmailHubs({}), /at least one account/);
  assert.throws(() => createEmailHubs({ accounts: { 'Bad Id': { provider: p } } }), /cannot be an account id/);
  assert.throws(() => createEmailHubs({ accounts: { accounts: { provider: p } } }), /cannot be an account id/);
  assert.throws(() => createEmailHubs({ accounts: { a: {} } }), /needs a provider/);
  ok('bad ids, the reserved id and a missing provider are refused');
}

console.log('server: an account can move people in from another service');
{
  const hubs = createEmailHubs({ accounts: { a: { provider: createMemoryProvider(), migrateFrom: createMemoryProvider() }, b: { provider: createMemoryProvider() } } });
  assert.equal((await call(hubs, 'GET', '/a/config')).body.migrate.from, 'Memory');
  assert.equal((await call(hubs, 'GET', '/b/config')).body.migrate, null);
  ok('options such as migrateFrom belong to one account');
}

console.log('screens: the switcher');
{
  const mounted = [];
  const mount = (host, opts) => { const h = { host, opts, destroyed: false, destroy() { h.destroyed = true; } }; mounted.push(h); return h; };
  const makeRoot = () => { const select = { value: '', handlers: {}, addEventListener(e, f) { this.handlers[e] = f; } }; const host = {}; return { select, host, classes: new Set(), classList: { add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, s: null }, innerHTML: '', querySelector(sel) { return sel === '#eh-account' ? select : host; } }; };
  const root = makeRoot(); root.classList.s = root.classes;
  const accounts = [{ id: 'main', label: 'Main list' }, { id: 'other', label: 'Other <list>', brandName: 'Other' }];
  const ui = mountEmailHubs(root, { base: '/api/email', accounts, mount, timeZone: 'UTC', draftKey: 'draft' });
  assert.equal(ui.account, 'main');
  assert.equal(mounted[0].opts.base, '/api/email/main');
  assert.equal(mounted[0].opts.draftKey, 'draft-main');
  assert.equal(mounted[0].opts.timeZone, 'UTC', 'other options pass through');
  assert.ok(root.innerHTML.includes('Other &lt;list&gt;'), 'labels are escaped');
  root.select.value = 'other'; root.select.handlers.change();
  assert.equal(mounted.length, 2); assert.equal(mounted[0].destroyed, true);
  assert.equal(mounted[1].opts.base, '/api/email/other');
  assert.equal(mounted[1].opts.draftKey, 'draft-other');
  assert.equal(mounted[1].opts.brandName, 'Other');
  assert.equal(ui.account, 'other');
  ui.show('nope'); assert.equal(ui.account, 'other', 'an unknown account is ignored');
  ui.destroy(); assert.equal(mounted[1].destroyed, true);
  ok('one hub per account, swapped on change, drafts kept apart, labels escaped');

  const root2 = makeRoot(); root2.classList.s = root2.classes;
  const single = mountEmailHubs(root2, { base: '/api/email', mount });
  assert.equal(single, mounted.at(-1)); assert.equal(mounted.at(-1).opts.base, '/api/email');
  ok('with no accounts it is the plain hub');

  const root3 = makeRoot(); root3.classList.s = root3.classes;
  mountEmailHubs(root3, { base: '/b', accounts, account: 'other', mount });
  assert.equal(mounted.at(-1).opts.base, '/b/other');
  ok('it can start on a chosen account');
}

console.log(`\n${n} account checks passed`);
