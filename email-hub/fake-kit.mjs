/*
  A stand-in for Kit's v4 API, for tests. It replaces nothing global: hand its `fetch` to createKitProvider. It keeps
  state, so a whole scenario can run against it: a draft becomes scheduled and back, a subscriber's state is never
  changed by adding them again, and a total is only returned when it is asked for. Nothing here reaches the network.
*/
export function fakeKit({ now = () => Date.now() } = {}) {
  const state = { broadcasts: new Map(), subs: [], tags: [], tagged: new Map(), seq: 100, fields: [{ key: 'last_name', label: 'Last name' }] };
  const calls = [];
  const iso = () => new Date(now()).toISOString();
  const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const page = (rows, key, u, extra = {}) => { const per = Number(u.searchParams.get('per_page') || 25); const total = u.searchParams.get('include_total_count') === 'true' ? { total_count: rows.length } : {}; return { [key]: rows.slice(0, per), pagination: { has_next_page: rows.length > per, end_cursor: rows.length > per ? 'next' : null, ...total, ...extra } }; };
  const sub = (s) => ({ id: s.id, email_address: s.email_address, first_name: s.first_name || '', state: s.state, created_at: s.created_at, fields: { last_name: s.last_name || '' } });

  const fetch = async (url, init = {}) => {
    const u = new URL(String(url)); const path = u.pathname.replace(/^\/v4/, ''); const method = (init.method || 'GET').toUpperCase(); const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body, key: init.headers?.['X-Kit-Api-Key'] });
    let m;
    if (method === 'GET' && path === '/broadcasts') return reply(200, page([...state.broadcasts.values()], 'broadcasts', u));
    if (method === 'POST' && path === '/broadcasts') { const id = ++state.seq; const b = { id, status: body.send_at ? 'scheduled' : 'draft', created_at: iso(), public_url: null, ...body }; state.broadcasts.set(String(id), b); return reply(201, { broadcast: b }); }
    if ((m = /^\/broadcasts\/(\d+)$/.exec(path))) {
      const b = state.broadcasts.get(m[1]); if (!b) return reply(404, { error: 'not found' });
      if (method === 'GET') return reply(200, { broadcast: b });
      if (method === 'PUT') { Object.assign(b, body); if ('send_at' in body) b.status = body.send_at ? 'scheduled' : 'draft'; return reply(200, { broadcast: b }); }
      if (method === 'DELETE') { state.broadcasts.delete(m[1]); return reply(204); }
    }
    if (method === 'GET' && (m = /^\/broadcasts\/(\d+)\/stats$/.exec(path))) { const b = state.broadcasts.get(m[1]); return b ? reply(200, { broadcast: { id: b.id, stats: b.stats || {} } }) : reply(404, {}); }
    if (method === 'GET' && path === '/tags') return reply(200, { tags: state.tags.map((t) => ({ ...t, subscriber_count: (state.tagged.get(t.id) || new Set()).size })) });
    if (method === 'POST' && path === '/tags') { let t = state.tags.find((x) => x.name === body.name); if (!t) { t = { id: ++state.seq, name: body.name }; state.tags.push(t); } return reply(200, { tag: t }); }
    if ((m = /^\/tags\/(\d+)\/subscribers(?:\/(\d+))?$/.exec(path))) {
      const tid = Number(m[1]); const set = state.tagged.get(tid) || new Set(); state.tagged.set(tid, set);
      if (method === 'POST') { const s = state.subs.find((x) => x.email_address === body.email_address); if (!s) return reply(404, {}); set.add(s.id); return reply(201, { subscriber: sub(s) }); }
      if (method === 'DELETE') { set.delete(Number(m[2])); return reply(204); }
      if (method === 'GET') { const st = u.searchParams.get('status'); return reply(200, page(state.subs.filter((s) => set.has(s.id) && (!st || st === 'all' || s.state === st)).map(sub), 'subscribers', u)); }
    }
    if (method === 'GET' && path === '/segments') return reply(200, { segments: [{ id: 900, name: 'Recent' }] });
    if (method === 'GET' && path === '/subscribers') {
      const st = u.searchParams.get('status'), e = u.searchParams.get('email_address');
      const rows = state.subs.filter((s) => (!e || s.email_address === e) && (!st || st === 'all' || s.state === st)).sort((a, b) => String(b.created_at).localeCompare(a.created_at));
      return reply(200, page(rows.map(sub), 'subscribers', u));
    }
    if (method === 'POST' && path === '/subscribers') { let s = state.subs.find((x) => x.email_address === body.email_address); if (!s) { s = { id: ++state.seq, email_address: body.email_address, first_name: body.first_name || '', state: body.state || 'active', created_at: iso() }; state.subs.push(s); } return reply(200, { subscriber: sub(s) }); }   // an upsert that never changes an existing person's state
    if ((m = /^\/subscribers\/(\d+)$/.exec(path)) && method === 'GET') { const s = state.subs.find((x) => String(x.id) === m[1]); return s ? reply(200, { subscriber: sub(s) }) : reply(404, {}); }
    if ((m = /^\/subscribers\/(\d+)\/tags$/.exec(path)) && method === 'GET') return reply(200, { tags: state.tags.filter((t) => (state.tagged.get(t.id) || new Set()).has(Number(m[1]))) });
    if ((m = /^\/subscribers\/(\d+)\/unsubscribe$/.exec(path)) && method === 'POST') { const s = state.subs.find((x) => String(x.id) === m[1]); if (s) s.state = 'cancelled'; return reply(200, {}); }
    if (method === 'GET' && path === '/account/growth_stats') { const from = Date.parse(u.searchParams.get('starting')); const added = state.subs.filter((s) => Date.parse(s.created_at) >= from && s.state === 'active').length; const gone = state.subs.filter((s) => s.state === 'cancelled').length; return reply(200, { stats: { new_subscribers: added, cancellations: gone, net_new_subscribers: added - gone } }); }
    if (method === 'GET' && path === '/custom_fields') return reply(200, { custom_fields: state.fields });
    return reply(404, { error: `fake kit has no ${method} ${path}` });
  };
  return {
    fetch, state, calls,
    addSubscriber: (email, over = {}) => { const s = { id: ++state.seq, email_address: email, first_name: '', state: 'active', created_at: iso(), ...over }; state.subs.push(s); return s; },
    addBroadcast: (over = {}) => { const id = ++state.seq; const b = { id, status: 'draft', subject: '', description: '', preview_text: '', content: '', created_at: iso(), send_at: null, subscriber_filter: [], ...over }; state.broadcasts.set(String(id), b); return b; }
  };
}
