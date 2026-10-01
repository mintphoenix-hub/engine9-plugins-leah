/*
  More than one email marketing account in one hub (for example two Kit accounts, or a Kit and a Mailchimp). Each account is a
  whole hub of its own: its own provider, look, logos, archive and options. This only routes to the right one.

    const hubs = createEmailHubs({
      accounts: {
        main:  { label: 'Main list',  provider: createProvider('kit', { apiKey: env.KIT_API_KEY }), store: createD1Store({ db, tablePrefix: '' }),          brand: { name: 'Example' } },
        other: { label: 'Other list', provider: createProvider('kit', { apiKey: env.OTHER_KIT_KEY }), store: createD1Store({ db, tablePrefix: 'other_' }), brand: { name: 'Other' } },
      },
      now,                                   // anything else is a default for every account; an account's own value wins
    });
    // in the host's route, after the admin check:  /api/admin/email/<rest>
    const res = await hubs.handle(request, '/accounts', 'GET');          // which accounts there are
    const res = await hubs.handle(request, '/main/campaigns', 'GET');    // the "main" account's hub, route /campaigns

  Sending to either list, or to both without anyone getting it twice (crosslist.js):
    GET  /send/plan?primary=main&secondary=other        how many people are on both lists (read-only)
    POST /send/mark     { primary, secondary, after }    tag the second list's people who are on the first (bounded; repeat with `next`)
    POST /send/draft    { audiences: ['main'] | ['other'] | ['main','other'], primary?, ...the email (subject, text, ...) }
    POST /send/schedule { drafts: [{ account, id }], sendAt, confirm, marked }
  One audience is an ordinary email from that account. Two audiences make a pair of drafts: the first list's (everyone, or a tag
  with `to: { main: 't:12' }`) and the second's, addressed to everyone except people already on the first. Scheduling a pair
  needs `marked: true` (you updated the overlap just now), checks the second is an "everyone except" draft, schedules the first
  and then the second, and takes the first back if the second fails, so it is never left half done.

  Each account keeps its own tables if the host gives it its own `createD1Store({ tablePrefix })`; two accounts on one store would
  share a look and an archive. Account ids are lower-case letters, numbers, `-` and `_`, starting with a letter. `accounts` is
  reserved. Returns null for anything that is not an account's route, like createEmailHub().handle does.
*/
import { createEmailHub } from './routes.js';
import { createCrossList } from './crosslist.js';
import { HubError } from './provider.js';

const ID = /^[a-z][a-z0-9_-]{0,30}$/;
const RESERVED = new Set(['accounts', 'send']);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export function createEmailHubs({ accounts, ...shared } = {}) {
  const ids = Object.keys(accounts || {});
  if (!ids.length) throw new Error('createEmailHubs needs at least one account.');
  const hubs = new Map();
  for (const id of ids) {
    if (!ID.test(id) || RESERVED.has(id)) throw new Error(`"${id}" cannot be an account id: use lower-case letters, numbers, - and _, starting with a letter.`);
    const { label, ...own } = accounts[id] || {};
    if (!own.provider) throw new Error(`The "${id}" account needs a provider.`);
    hubs.set(id, { label: String(label || own.brand?.name || id), provider: own.provider, hub: createEmailHub({ ...shared, ...own }) });
  }

  const crosses = new Map();
  const cross = (p, q) => {
    for (const x of [p, q]) if (!hubs.has(x)) throw new HubError('That is not an account we know.', 404);
    if (p === q) throw new HubError('Pick two different lists.', 422);
    const key = `${p}>${q}`;
    if (!crosses.has(key)) crosses.set(key, createCrossList({ primary: hubs.get(p).provider, secondary: hubs.get(q).provider, tagName: `Also on ${hubs.get(p).label}` }));
    return crosses.get(key);
  };
  /* A call into one account's own hub, so its rules (drafts only, the tick, quarter hours) apply unchanged. */
  const inner = async (account, method, path, body) => {
    const res = await hubs.get(account).hub.handle(new Request(`https://hub.invalid${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, method);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || res.status >= 400) throw new HubError(data.error || 'That did not work.', res?.status || 404);
    return data;
  };
  const readBody = async (request) => { try { return await request.json(); } catch { throw new HubError('Bad request.'); } };

  async function send(request, url, method, step) {
    if (step === 'plan' && method === 'GET') return json(200, await cross(url.searchParams.get('primary'), url.searchParams.get('secondary')).plan());
    if (step === 'mark' && method === 'POST') {
      const b = await readBody(request);
      return json(200, await cross(b.primary, b.secondary).mark({ after: b.after }));
    }
    if (step === 'draft' && method === 'POST') {
      const b = await readBody(request);
      const audiences = [...new Set(Array.isArray(b.audiences) ? b.audiences.map(String) : [])];
      if (audiences.length < 1 || audiences.length > 2) throw new HubError('Pick one list, or two.', 422);
      for (const a of audiences) if (!hubs.has(a)) throw new HubError('That is not an account we know.', 404);
      const { audiences: _a, primary: _p, to: toMap, ...email } = b;
      const toFor = (a) => (toMap && typeof toMap === 'object' && toMap[a]) || '';
      if (audiences.length === 1) {
        const made = await inner(audiences[0], 'POST', '/campaigns', { ...email, to: toFor(audiences[0]) });
        return json(200, { drafts: [{ account: audiences[0], ...made }], pair: false });
      }
      const first = audiences.includes(b.primary) ? b.primary : audiences[0];
      const second = audiences.find((a) => a !== first);
      if (toFor(second)) throw new HubError('The second list gets everyone not already on the first, so it cannot be narrowed to a tag or segment.', 422);
      const link = cross(first, second);
      const tag = await link.tag();
      const one = await inner(first, 'POST', '/campaigns', { ...email, to: toFor(first) });
      let two;
      try { two = await inner(second, 'POST', '/campaigns', { ...email, to: '', excludeTag: String(tag.id) }); }
      catch (e) { await inner(first, 'DELETE', `/campaigns/${one.campaign.id}`).catch(() => {}); throw e; }   // never leave one half of a pair
      return json(200, { drafts: [{ account: first, ...one }, { account: second, ...two }], pair: true, tag: { id: String(tag.id), name: tag.name }, needsMark: true });
    }
    if (step === 'schedule' && method === 'POST') {
      const b = await readBody(request);
      const drafts = Array.isArray(b.drafts) ? b.drafts : [];
      if (drafts.length < 1 || drafts.length > 2) throw new HubError('Pick one email, or a pair.', 422);
      for (const d of drafts) if (!hubs.has(String(d?.account)) || !/^[A-Za-z0-9_-]{1,40}$/.test(String(d?.id))) throw new HubError('That is not an email we know.', 404);
      const when = { sendAt: b.sendAt, confirm: b.confirm };
      if (drafts.length === 1) return json(200, { scheduled: [{ account: drafts[0].account, ...(await inner(drafts[0].account, 'POST', `/campaigns/${drafts[0].id}/schedule`, when)) }] });
      if (drafts[0].account === drafts[1].account) throw new HubError('A pair is one email from each list.', 422);
      if (b.marked !== true) throw new HubError('Update who is on both lists just now, then tick the box to say you did.', 409);
      const second = await inner(drafts[1].account, 'GET', `/campaigns/${drafts[1].id}`);
      if (second.campaign?.segment !== 'Everyone except a tag') throw new HubError('The second email is not set to skip people on the first list, so it will not be scheduled.', 409);
      const done = [];
      try {
        done.push({ account: drafts[0].account, ...(await inner(drafts[0].account, 'POST', `/campaigns/${drafts[0].id}/schedule`, when)) });
        done.push({ account: drafts[1].account, ...(await inner(drafts[1].account, 'POST', `/campaigns/${drafts[1].id}/schedule`, when)) });
      } catch (e) {
        if (done.length) await inner(drafts[0].account, 'POST', `/campaigns/${drafts[0].id}/unschedule`, {}).catch(() => {});
        throw new HubError(`Nothing was scheduled. ${e.message}`, e.http || 409);
      }
      return json(200, { scheduled: done });
    }
    return json(405, { error: 'That is not something we do.' });
  }

  async function handle(request, path, method = request.method) {
    try {
      if (path === '/accounts') {
        if (method !== 'GET') return json(405, { error: 'That is not something we do.' });
        return json(200, { accounts: ids.map((id) => ({ id, label: hubs.get(id).label, service: hubs.get(id).provider.label, connected: Boolean(hubs.get(id).provider.connected()), canExclude: Boolean(hubs.get(id).provider.capabilities?.excludeAudience) })) });
      }
      const sm = /^\/send\/(plan|mark|draft|schedule)$/.exec(String(path || ''));
      if (sm) return await send(request, new URL(request.url), method, sm[1]);
      const m = /^\/([a-z][a-z0-9_-]{0,30})(\/.*)?$/.exec(String(path || ''));
      if (!m || !hubs.has(m[1])) return null;
      return await hubs.get(m[1]).hub.handle(request, m[2] || '/', method);
    } catch (e) {
      if (e instanceof HubError) return json(e.http || 400, { error: e.message });
      return json(500, { error: 'Something went wrong. Try again.' });
    }
  }

  return { handle, accounts: ids, hub: (id) => hubs.get(id)?.hub || null };
}
