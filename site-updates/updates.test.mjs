import assert from 'node:assert/strict';
import { pinnedSha, isCurrent, stateOf, checkUpdate, startUpdate, updateRoutes, ADMIN_HEADER } from './updates.js';
import { describe, short } from './banner.js';

const NEW = '89c0a51d3833ceba5adb4907b611bd64a4072ce7';
assert.equal(pinnedSha({ dependencies: { '@engine9/core': 'github:engine9-ai/core#03de2f62' } }), '03de2f62');
assert.equal(pinnedSha({ dependencies: { '@engine9/core': '^1.4.0' } }), null);
assert.ok(isCurrent('89c0a51', NEW) && !isCurrent('03de2f6', NEW) && !isCurrent(null, NEW));
assert.equal(stateOf({ pin: '03de2f6', newest: NEW, pr: null, running: false }), 'available');
assert.equal(stateOf({ pin: '89c0a51', newest: NEW, pr: null, running: false }), 'current');
assert.equal(stateOf({ pin: '03de2f6', newest: NEW, pr: null, running: true }), 'running');
assert.equal(stateOf({ pin: '03de2f6', newest: NEW, pr: { number: 1 }, running: true }), 'ready');
assert.equal(stateOf({ pin: null, newest: NEW, pr: null, running: false }), 'unknown');

/* A fake GitHub. `world` is what it says; `calls` is what was asked. */
function fakeGithub(world) {
  const calls = [];
  const f = async (url, init = {}) => {
    const path = url.replace('https://api.github.com', ''); const method = init.method || 'GET';
    calls.push({ method, path, auth: init.headers?.Authorization, body: init.body });
    const ok = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => (typeof data === 'string' ? data : JSON.stringify(data)) });
    if (world.fail) return { ok: false, status: world.fail };
    if (path === '/repos/engine9-ai/core/commits/HEAD') return ok({ sha: world.newest || NEW });
    if (path === '/repos/o/site/contents/package.json') return ok(JSON.stringify({ dependencies: { '@engine9/core': `github:engine9-ai/core#${world.pin || '03de2f62'}` } }));
    if (path.startsWith('/repos/o/site/pulls')) return ok(world.prs || []);
    if (path.startsWith('/repos/o/site/actions/workflows/engine9-updates.yml/runs')) return ok({ workflow_runs: world.runs || [] });
    if (path === '/repos/o/site') return ok({ default_branch: 'main' });
    if (path === '/repos/o/site/actions/workflows/engine9-updates.yml/dispatches' && method === 'POST') return ok(null, 204);
    return { ok: false, status: 404 };
  };
  return { f, calls };
}

let g = fakeGithub({});
let s = await checkUpdate({ fetch: g.f, repo: 'o/site', token: 't0k' });
assert.equal(s.state, 'available'); assert.equal(s.pinned, '03de2f62'); assert.equal(s.newest, NEW);
assert.ok(g.calls.every((c) => c.auth === 'Bearer t0k'));

s = await checkUpdate({ fetch: fakeGithub({ pin: '89c0a51' }).f, repo: 'o/site', token: 't' });
assert.equal(s.state, 'current');

s = await checkUpdate({ fetch: fakeGithub({ prs: [{ number: 7, html_url: 'https://github.com/o/site/pull/7', draft: false, title: 'x', head: { ref: 'engine9-update/2026-09-29' } }, { number: 8, head: { ref: 'feature' } }] }).f, repo: 'o/site', token: 't' });
assert.equal(s.state, 'ready'); assert.equal(s.pr.number, 7);

s = await checkUpdate({ fetch: fakeGithub({ prs: [{ number: 8, head: { ref: 'feature' } }] }).f, repo: 'o/site', token: 't' });
assert.equal(s.state, 'available', 'an unrelated pull request is not an update');

s = await checkUpdate({ fetch: fakeGithub({ runs: [{ status: 'in_progress' }] }).f, repo: 'o/site', token: 't' });
assert.equal(s.state, 'running');

s = await checkUpdate({ fetch: fakeGithub({ fail: 401 }).f, repo: 'o/site', token: 'SECRET-TOKEN' });
assert.equal(s.state, 'error'); assert.ok(!JSON.stringify(s).includes('SECRET-TOKEN'));

/* start */
g = fakeGithub({});
let r = await startUpdate({ fetch: g.f, repo: 'o/site', token: 't' });
assert.equal(r.started, true); assert.equal(r.status.state, 'running');
const post = g.calls.find((c) => c.method === 'POST'); assert.equal(JSON.parse(post.body).ref, 'main');

g = fakeGithub({ pin: '89c0a51' });
r = await startUpdate({ fetch: g.f, repo: 'o/site', token: 't' });
assert.equal(r.started, false); assert.equal(r.reason, 'current'); assert.ok(!g.calls.some((c) => c.method === 'POST'));

g = fakeGithub({ runs: [{ status: 'queued' }] });
r = await startUpdate({ fetch: g.f, repo: 'o/site', token: 't' });
assert.equal(r.started, false); assert.equal(r.reason, 'running', 'never starts a second run');

/* routes */
const req = (method, path = '/api/admin/engine9-update', headers = {}) => new Request(`https://x.test${path}`, { method, headers });
const routes = (o = {}) => updateRoutes({ repo: 'o/site', token: 't', fetch: fakeGithub({}).f, isAdmin: async () => true, ...o });
assert.equal(await routes()(req('GET', '/other')), null, 'other paths are the host\'s');
assert.equal((await routes({ isAdmin: async () => false })(req('GET'))).status, 403);
assert.equal((await routes({ isAdmin: undefined })(req('GET'))).status, 403, 'no isAdmin means no access');
assert.equal((await routes()(req('DELETE'))).status, 405);
assert.equal((await (await routes()(req('GET'))).json()).state, 'available');
assert.equal((await routes()(req('POST'))).status, 400, 'a POST without the header is refused');
assert.equal((await (await routes()(req('POST', undefined, { [ADMIN_HEADER]: '1' }))).json()).started, true);
assert.equal((await (await routes({ token: '' })(req('GET'))).json()).state, 'error');

/* banner text */
assert.equal(describe({ state: 'current' }), null);
assert.equal(describe({ state: 'error' }), null);
assert.ok(describe({ state: 'available', pinned: '03de2f62', newest: NEW }).text.includes('03de2f6 to 89c0a51'));
assert.equal(describe({ state: 'available', pinned: 'a', newest: 'b' }).button, 'Update');
assert.ok(describe({ state: 'running' }).busy);
const ready = describe({ state: 'ready', pr: { number: 7, url: 'https://github.com/o/site/pull/7', draft: true } }, { readyNote: 'Merging deploys.' });
assert.ok(ready.text.includes('draft') && ready.text.includes('Merging deploys.') && ready.link.label.includes('#7'));
assert.equal(short(NEW), '89c0a51');
console.log('site-updates: passed');
