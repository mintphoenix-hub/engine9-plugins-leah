/*
  Tells a site's admin that an engine9 update is available, and starts it when the person confirms.

  It does no I/O of its own: the host passes `fetch` and the GitHub token, so the same code runs in a Worker, Node
  and a test. Nothing here merges or deploys. "Start the update" runs the site's own `engine9-updates` workflow,
  which installs, tests and opens a pull request; the person reads and merges that on GitHub.

  Core publishes no releases, so "newer" means a newer commit on its main branch than the one the site's package.json
  pins @engine9/core to (read from the repository's default branch, which is what the next update builds on).
*/
export const CORE_REPO = 'engine9-ai/core';
export const WORKFLOW = 'engine9-updates.yml';
export const BRANCH_PREFIX = 'engine9-update/';
export const ADMIN_HEADER = 'x-engine9-update';
const BUSY = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/* The commit a package.json pins core to: "github:engine9-ai/core#03de2f6" -> "03de2f6". Null when it is not a commit. */
export function pinnedSha(pkg) {
  const spec = pkg?.dependencies?.['@engine9/core'] ?? pkg?.devDependencies?.['@engine9/core'] ?? '';
  return (/#([0-9a-f]{7,40})$/.exec(spec) || [])[1] || null;
}

/* Pins are often abbreviated, so compare as a prefix. */
export const isCurrent = (pin, newest) => Boolean(pin && newest && String(newest).startsWith(pin));

/* One word for the banner. An open update pull request wins (there is something to review), then a run in progress. */
export function stateOf({ pin, newest, pr, running }) {
  if (pr) return 'ready';
  if (running) return 'running';
  if (!pin || !newest) return 'unknown';
  return isCurrent(pin, newest) ? 'current' : 'available';
}

async function github(fetchFn, token, path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetchFn(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'User-Agent': 'engine9-site-updates',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} answered ${res.status}`);
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

/* { state, repo, pinned, newest, pr: {number, url, draft, title} | null, running } . Never throws: a failure is state 'error'
   with a short message (never the token). */
export async function checkUpdate({ fetch: fetchFn = globalThis.fetch, repo, token, workflow = WORKFLOW, coreRepo = CORE_REPO }) {
  try {
    const [head, pkgText, pulls, runs] = await Promise.all([
      github(fetchFn, token, `/repos/${coreRepo}/commits/HEAD`),
      github(fetchFn, token, `/repos/${repo}/contents/package.json`, { raw: true }),
      github(fetchFn, token, `/repos/${repo}/pulls?state=open&per_page=50`),
      github(fetchFn, token, `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=5`)
    ]);
    const pin = pinnedSha(JSON.parse(pkgText));
    const found = (pulls || []).find((p) => String(p.head?.ref || '').startsWith(BRANCH_PREFIX));
    const pr = found ? { number: found.number, url: found.html_url, draft: Boolean(found.draft), title: found.title } : null;
    const running = (runs?.workflow_runs || []).some((r) => BUSY.has(r.status));
    return { state: stateOf({ pin, newest: head?.sha, pr, running }), repo, pinned: pin, newest: head?.sha || null, pr, running };
  } catch (e) {
    return { state: 'error', repo, message: String(e.message || e).slice(0, 200) };
  }
}

/* Starts the site's update workflow, but only when there is something to do and nothing is already under way. */
export async function startUpdate({ fetch: fetchFn = globalThis.fetch, repo, token, workflow = WORKFLOW, ref, coreRepo = CORE_REPO }) {
  const status = await checkUpdate({ fetch: fetchFn, repo, token, workflow, coreRepo });
  if (status.state !== 'available') return { started: false, reason: status.state, status };
  try {
    const branch = ref || (await github(fetchFn, token, `/repos/${repo}`)).default_branch;
    await github(fetchFn, token, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: { ref: branch } });
    return { started: true, status: { ...status, state: 'running', running: true } };
  } catch (e) {
    return { started: false, reason: 'error', status: { state: 'error', repo, message: String(e.message || e).slice(0, 200) } };
  }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/* The two routes, for a host to mount behind its own admin sign-in:
     GET  <path>  -> the status above
     POST <path>  -> start the update (needs the custom header, so another website cannot make an admin's browser do it)
   Returns null for any other request, so the host carries on with its own routing.
   `isAdmin(request)` is required and decides who may see or start it; without it every request is refused. */
export function updateRoutes({ repo, token, isAdmin, path = '/api/admin/engine9-update', fetch: fetchFn, workflow }) {
  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== path) return null;
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (typeof isAdmin !== 'function' || !(await isAdmin(request))) return json({ error: 'forbidden' }, 403);
    if (!repo || !token) return json({ state: 'error', message: 'Updates are not set up on this site (repository or token missing).' });
    if (request.method === 'GET') return json(await checkUpdate({ fetch: fetchFn, repo, token, workflow }));
    if (!request.headers.get(ADMIN_HEADER)) return json({ error: 'missing header' }, 400);
    return json(await startUpdate({ fetch: fetchFn, repo, token, workflow }));
  };
}
