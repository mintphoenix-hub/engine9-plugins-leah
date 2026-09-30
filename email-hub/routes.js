/*
  The hub's JSON API, as a plain Request -> Response handler. It runs in a Worker, Node or a test.

    const hub = createEmailHub({ provider, brand, store });
    // in the host, after it has checked the person is signed in as the owner:
    const res = await hub.handle(request, '/campaigns', 'GET');     // null when the path is not the hub's

  The host owns sign-in, the provider's key, and where the look is stored (`store`). The hub owns the rules:
  scheduling is guarded (schedule.js), only a draft can change or go, and a test send goes only to the addresses given.
*/
import { assertProvider, capabilitiesOf, HubError } from './provider.js';
import { planSchedule, isDraft } from './schedule.js';
import { bodyHtml, checkStyle, defaultStyle, StyleError } from './shell.js';
import { cleanPeople, isEmail, MAX_IMPORT } from './csv.js';
import { emailsIn } from './stats.js';
import { unsubscribeLink, handleUnsubscribe } from './unsubscribe.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => Array.from(String(v ?? '')).slice(0, n).join('');

/* 't:123' is a tag, 's:45' a saved segment, '' is everyone. */
export function parseTo(to) {
  const m = /^([ts]):([A-Za-z0-9_-]{1,40})$/.exec(String(to || ''));
  if (!m) return {};
  return m[1] === 't' ? { tagId: m[2] } : { segmentId: m[2] };
}

const ROUTE = /^\/(campaigns|audience|overview|contacts|tags|fields|import|look|config)(?:\/([A-Za-z0-9_-]+))?(?:\/(content|duplicate|schedule|unschedule|test|checklist|report|tags|unsubscribe))?$/;

export function createEmailHub({ provider, brand = {}, store = null, now = () => Date.now() } = {}) {
  assertProvider(provider);
  const caps = capabilitiesOf(provider);
  const need = (k) => { if (!caps[k]) throw new HubError('That is not something this email service can do from here.', 405); };

  const loadStyle = async () => {
    try { const raw = store?.loadStyle ? await store.loadStyle() : null; return raw ? checkStyle(raw, brand) : defaultStyle(brand); }
    catch { return defaultStyle(brand); }
  };
  const readBody = async (request) => { try { return await request.json(); } catch { throw new HubError('Bad request.'); } };
  const draftOnly = async (id, what) => {
    const c = await provider.getCampaign(id);
    if (!isDraft(c)) throw new HubError(`That email is no longer a draft, so you cannot ${what}. Refresh the page.`, 409);
    return c;
  };

  async function campaigns(request, method, id, action) {
    if (!id && method === 'GET') return json(200, { connected: true, ...(await provider.listCampaigns()) });
    if (!id && method === 'POST') {
      const b = await readBody(request);
      const subject = clip(b.subject, 150).trim();
      if (!subject) throw new HubError('An email needs a subject line.');
      const text = clip(b.text, 20000);
      if (!text.trim()) throw new HubError('An email needs some words in it.');
      const html = bodyHtml(text, { style: await loadStyle(), address: provider.mergeTags.address, unsubscribe: provider.mergeTags.unsubscribe, siteUnsubscribe: unsubscribeLink(brand.unsubscribePage, provider) || '', brand });
      const c = await provider.createCampaign({ subject, previewText: clip(b.previewText, 150).trim(), title: clip(b.title, 100).trim(), html, to: parseTo(b.to) });
      return json(200, { campaign: c });
    }
    if (id && !action) {
      if (method === 'GET') return json(200, { campaign: await provider.getCampaign(id) });
      if (method === 'PATCH') {
        const b = await readBody(request); await draftOnly(id, 'change it');
        const f = {};
        if (typeof b.subject === 'string') { if (!b.subject.trim()) throw new HubError('An email needs a subject line.'); f.subject = clip(b.subject, 150).trim(); }
        if (typeof b.previewText === 'string') f.previewText = clip(b.previewText, 150).trim();
        if (typeof b.title === 'string' && b.title.trim()) f.title = clip(b.title, 100).trim();
        if (!Object.keys(f).length) throw new HubError('Nothing to change.');
        return json(200, { campaign: await provider.updateCampaign(id, f) });
      }
      if (method === 'DELETE') { const c = await draftOnly(id, 'delete it'); await provider.deleteCampaign(id); return json(200, { ok: true, id: c.id }); }
    }
    if (id && action === 'content' && method === 'GET') return json(200, await provider.campaignContent(id));
    if (id && action === 'report' && method === 'GET') { need('report'); return json(200, await provider.campaignReport(id)); }
    if (id && action === 'checklist' && method === 'GET') { need('checklist'); return json(200, await provider.sendChecklist(id)); }
    if (id && action === 'duplicate' && method === 'POST') return json(200, { campaign: await provider.duplicateCampaign(id) });
    if (id && action === 'schedule' && method === 'POST') {
      const b = await readBody(request);
      const plan = planSchedule(b.sendAt, b.confirm, now());
      await draftOnly(id, 'schedule it again');
      if (caps.checklist) {
        const list = await provider.sendChecklist(id);
        if (!list.ready) {
          const why = (list.problems || []).map((p) => p.heading || p.details).filter(Boolean).slice(0, 3).join('; ');
          throw new HubError(`${provider.label} says this email is not ready to send${why ? `: ${why}` : ''}. Open it in ${provider.label} to finish it.`, 409);
        }
      }
      await provider.schedule(id, plan.iso);
      return json(200, { campaign: await provider.getCampaign(id), scheduledFor: plan.iso });
    }
    if (id && action === 'unschedule' && method === 'POST') {
      const c = await provider.getCampaign(id);
      if (c.status !== 'schedule') throw new HubError('That email is not scheduled.', 409);
      await provider.unschedule(id);
      return json(200, { campaign: await provider.getCampaign(id) });
    }
    if (id && action === 'test' && method === 'POST') {
      need('test');
      const b = await readBody(request);
      const list = [...new Set((Array.isArray(b.emails) ? b.emails : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      if (!list.length) throw new HubError('Enter an email address to send the test to.');
      if (list.length > 3) throw new HubError('A test can go to three addresses at most.');
      if (list.some((e) => !isEmail(e))) throw new HubError('One of those does not look like an email address.');
      return json(200, await provider.sendTest(id, list));
    }
    return json(405, { error: 'That is not something we do.' });
  }

  async function overview() {
    const list = await provider.listCampaigns(), all = list.campaigns, t = now();
    const part = async (fn) => { try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: e instanceof HubError ? e.message : 'That could not be read just now.' }; } };
    const [counts, g30, g90, audience] = await Promise.all([part(() => provider.counts()), part(() => provider.growth(30, t)), part(() => provider.growth(90, t)), provider.audience().catch(() => null)]);
    return { connected: true, dc: list.dc, audience, campaigns: all, counts, growth30: g30, growth90: g90, email30: { ok: true, data: emailsIn(all, 30, t) }, email90: { ok: true, data: emailsIn(all, 90, t) } };
  }

  async function contacts(request, url, method, id, sub) {
    need('contacts');
    if (!id && method === 'GET') {
      const q = url.searchParams;
      if (q.get('email') && !isEmail(q.get('email').trim())) throw new HubError('That does not look like a full email address.');   // one rule for every provider
      const [list, counts] = await Promise.all([provider.listContacts({ status: q.get('status') || 'subscribed', tag: q.get('tag') || '', email: q.get('email') || '', after: q.get('after') || '' }), q.get('counts') === '1' ? provider.counts() : null]);
      return json(200, { ...list, ...(counts ? { counts } : {}) });
    }
    if (!id && method === 'POST') {
      const b = await readBody(request);
      if (b.consent !== true) throw new HubError('Tick the box to say this person agreed to hear from you.');
      if (!isEmail(String(b.email || '').trim())) throw new HubError('That does not look like an email address.');
      return json(200, await provider.addContact({ email: String(b.email).trim().toLowerCase(), first: clip(b.first, 80).trim(), last: clip(b.last, 80).trim(), tag: clip(b.tag, 100).trim() }));
    }
    if (id && !sub && method === 'GET') return json(200, await provider.contact(id));
    if (id && sub === 'tags' && (method === 'POST' || method === 'DELETE')) {
      const name = clip((await readBody(request)).name, 100).trim();
      if (!name) throw new HubError('Choose a tag.');
      return json(200, await provider.tagContact(id, name, method === 'POST'));
    }
    if (id && sub === 'unsubscribe' && method === 'POST') return json(200, await provider.unsubscribeContact(id));
    return json(405, { error: 'That is not something we do.' });
  }

  /* Logo uploads and the archive of a previous provider's emails. Only when the store offers them. */
  async function extras(request, path, method) {
    const logo = /^\/look\/logos(?:\/([0-9a-f-]{8,36}))?$/.exec(path);
    if (logo) {
      need('look');
      if (method === 'POST' && !logo[1]) {
        if (!store?.addLogo) throw new HubError('Uploading logos is not switched on yet.', 503);
        let form; try { form = await request.formData(); } catch { throw new HubError('Choose a picture to upload.'); }
        return json(200, { logo: await store.addLogo(form.get('file'), form.get('name')) });
      }
      if (method === 'DELETE' && logo[1]) {
        if (!store?.removeLogo) throw new HubError('Uploading logos is not switched on yet.', 503);
        await store.removeLogo(logo[1]);
        return json(200, { ok: true, style: await loadStyle(), logos: await store.logos() });
      }
      return json(405, { error: 'That is not something we do.' });
    }
    if (path === '/archive' && method === 'GET') return json(200, { archive: store?.listArchive ? await store.listArchive() : [] });
    const arch = /^\/archive\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,80})\/content$/.exec(path);
    if (arch && method === 'GET') { const one = store?.archivedHtml ? await store.archivedHtml(arch[1], arch[2]) : null; return one ? json(200, one) : json(404, { error: 'That email is not in the archive.' }); }
    return null;
  }

  async function handle(request, path, method = request.method) {
    const isExtra = /^\/(look\/logos|archive)(\/|$)/.test(path);
    const m = isExtra ? null : ROUTE.exec(path);
    if (!m && !isExtra) return null;
    const [, area, id, sub] = m || [];
    const url = new URL(request.url);
    try {
      if (area === 'config') return json(200, { label: provider.label, capabilities: caps, brand: { name: brand.name || '' }, appUrl: provider.appUrl('/'), unsubscribePage: brand.unsubscribePage || null });
      // Logos and the archive do not need the service to be connected (the archive outlives it).
      if (isExtra) return (await extras(request, path, method)) || json(405, { error: 'That is not something we do.' });
      if (!provider.connected()) {
        if (method === 'GET') return json(200, { connected: false, campaigns: [], tags: [], segments: [], label: provider.label });
        throw new HubError(`${provider.label} is not connected yet.`, 503);
      }
      if (area === 'overview' && method === 'GET') return json(200, await overview());
      if (area === 'audience' && method === 'GET' && !id) return json(200, { connected: true, ...(await provider.audience()) });
      if (area === 'campaigns') return await campaigns(request, method, id, sub);
      if (area === 'contacts') return await contacts(request, url, method, id, sub);
      if (area === 'tags' && method === 'POST') { need('tags'); const n = clip((await readBody(request)).name, 100).trim(); if (!n) throw new HubError('Give the tag a name.'); return json(200, await provider.createTag(n)); }
      if (area === 'fields' && method === 'GET') { need('fields'); return json(200, await provider.fields()); }
      if (area === 'import' && method === 'POST') {
        need('import');
        const b = await readBody(request); const { people, invalid } = cleanPeople(b.people);
        if (!people.length) throw new HubError('No valid email addresses were found.');
        if (people.length > MAX_IMPORT) throw new HubError(`Import up to ${MAX_IMPORT.toLocaleString('en-US')} people at a time.`);
        return json(200, { ...(await provider.importContacts({ people, tag: clip(b.tag, 100).trim(), agreed: b.agreed === true })), count: people.length, invalid });
      }
      if (area === 'look') {
        need('look');
        if (method === 'GET') return json(200, { style: await loadStyle(), logos: store?.logos ? await store.logos() : [], defaults: defaultStyle(brand), canUpload: Boolean(store?.addLogo), canDelete: Boolean(store?.removeLogo), upload: store?.addLogo ? { maxBytes: store.maxLogoBytes || 2_000_000, types: store.logoTypes || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } : null });
        if (method === 'PATCH') {
          const b = await readBody(request);
          if (!store?.saveStyle) throw new HubError('Saving the email look is not switched on yet. Ask whoever looks after this site to finish the setup.', 503);
          if (b.reset === true) { await store.resetStyle?.(); return json(200, { style: defaultStyle(brand) }); }
          const s = checkStyle(b, brand); await store.saveStyle(s); return json(200, { style: s });
        }
      }
      return json(405, { error: 'That is not something we do.' });
    } catch (e) {
      if (e instanceof HubError) return json(e.http, { error: e.message });
      if (e instanceof StyleError) return json(400, { error: e.message });
      console.error('email-hub:', e?.status || e?.code || e?.message);
      return json(502, { error: `${provider.label} did not answer just now. Try again in a minute.` });
    }
  }
  /* The host's PUBLIC unsubscribe route (no sign-in: a person following an email link has none) calls this with the
     parsed JSON body and sends the { status, body } it returns. See unsubscribe.js. */
  const unsubscribe = (input) => handleUnsubscribe(provider, input);
  return { handle, provider, capabilities: caps, loadStyle, unsubscribe };
}
