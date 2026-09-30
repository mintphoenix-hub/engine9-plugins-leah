/*
  The hub's JSON API, as a plain Request -> Response handler. It runs in a Worker, Node or a test.

    const hub = createEmailHub({ provider, brand, store });
    // in the host, after it has checked the person is signed in as the owner:
    const res = await hub.handle(request, '/campaigns', 'GET');     // null when the path is not the hub's

  The host owns sign-in, the provider's key, and where the look is stored (`store`). The hub owns the rules:
  scheduling is guarded (schedule.js), only a draft can change or go, and a test send goes only to the addresses given.
*/
import { pickTemplate, renderTemplate } from './templates.js';
import { checkLayouts, listLayouts, cleanValues, renderLayout } from './layouts.js';
import { assertProvider, capabilitiesOf, HubError } from './provider.js';
import { planSchedule, isDraft, scheduleRules } from './schedule.js';
import { bodyHtml, checkStyle, defaultStyle, StyleError } from './shell.js';
import { cleanEmailHtml, checkEmailHtml, MAX_HTML } from './pasted.js';
import { cleanPeople, isEmail, MAX_IMPORT } from './csv.js';
import { emailsIn } from './stats.js';
import { unsubscribeLink, handleUnsubscribe } from './unsubscribe.js';
import { quietly } from './people.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => Array.from(String(v ?? '')).slice(0, n).join('');

/* 't:123' is a tag, 's:45' a saved segment, '' is everyone. */
export function parseTo(to) {
  const m = /^([ts]):([A-Za-z0-9_-]{1,40})$/.exec(String(to || ''));
  if (!m) return {};
  return m[1] === 't' ? { tagId: m[2] } : { segmentId: m[2] };
}

const ROUTE = /^\/(campaigns|audience|overview|contacts|tags|fields|import|look|config|templates|layouts)(?:\/([A-Za-z0-9_-]+))?(?:\/(content|duplicate|schedule|unschedule|test|checklist|report|tags|unsubscribe|render|layout|preview))?$/;

export function createEmailHub({ provider, brand = {}, store = null, now = () => Date.now(), schedule = {}, people = null, templates = null, defaultTemplate = '', layouts = null, layoutTemplateId = '', newTemplateId = '', templateSample = '' } = {}) {
  checkLayouts(layouts);
  const rules = scheduleRules(schedule);
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

  /* The id of a template that exists in the service (so a made-up one cannot be sent), or '' for "the service's default". */
  const knownTemplate = async (value) => {
    if (value == null || value === '') return '';
    need('templates');
    const found = ((await provider.listTemplates()).templates || []).find((t) => String(t.id) === String(value));
    if (!found) throw new HubError(`That template is not in ${provider.label}.`, 422);
    return String(found.id);
  };
  /* What a host layout's render() is given. */
  const layoutCtx = async () => ({ style: await loadStyle(), mergeTags: provider.mergeTags, brand, siteUnsubscribe: unsubscribeLink(brand.unsubscribePage, provider) || '' });
  const layoutsOn = () => Boolean(layouts && Object.keys(layouts).length && caps.layouts && store?.saveLayout);

  async function layoutRoutes(request, method, id, action) {
    if (!id && method === 'GET') return json(200, { enabled: layoutsOn(), layouts: layoutsOn() ? listLayouts(layouts) : [] });
    const lay = id && layouts?.[id];
    if (!lay) throw new HubError('There is no such layout.', 404);
    if (action === 'render' && method === 'POST') {          // a live preview of a form half filled in
      const values = cleanValues(lay, (await readBody(request)).values, { partial: true });
      const style = await loadStyle();
      const html = renderLayout(lay, values, await layoutCtx(), { check: false });
      return json(200, { html: renderTemplate(html, { message: '', address: style.address || brand.address || 'Your postal address' }) });
    }
    return json(405, { error: 'That is not something we do.' });
  }

  async function campaigns(request, method, id, action) {
    if (!id && method === 'GET') return json(200, { connected: true, ...(await provider.listCampaigns()) });
    if (!id && method === 'POST') {
      const b = await readBody(request);
      const subject = clip(b.subject, 150).trim();
      if (!subject) throw new HubError('An email needs a subject line.');
      if (b.layout) {                                                // made from a host layout: fields in, whole email out
        const lay = layouts?.[b.layout];
        if (!lay || !layoutsOn()) throw new HubError('That kind of email is not switched on here.', 404);
        const values = cleanValues(lay, b.values);
        const made = await provider.createCampaign({ subject, previewText: clip(b.previewText, 150).trim(), title: clip(b.title, 100).trim(), html: renderLayout(lay, values, await layoutCtx()), to: parseTo(b.to), ...(layoutTemplateId ? { templateId: layoutTemplateId } : {}) });
        await store.saveLayout(made.id, b.layout, values);
        return json(200, { campaign: made });
      }
      let html, warnings = [];
      if (typeof b.html === 'string' && b.html.trim()) {            // pasted HTML: cleaned and checked, then sent as it is
        html = cleanEmailHtml(b.html);
        const found = checkEmailHtml(html, { unsubscribe: provider.mergeTags.unsubscribe, address: provider.mergeTags.address });
        if (found.errors.length) throw new HubError(found.errors[0]);
        warnings = found.warnings;
      } else {
      const text = clip(b.text, 20000);
      if (!text.trim()) throw new HubError('An email needs some words in it.');
      html = bodyHtml(text, { style: await loadStyle(), address: provider.mergeTags.address, unsubscribe: provider.mergeTags.unsubscribe, siteUnsubscribe: unsubscribeLink(brand.unsubscribePage, provider) || '', brand });
      }
      // The template a new email is sent in: the one chosen, else the host's `newTemplateId` (a template that only holds the message, for a host
      // whose emails are whole designed emails), else the service's own default.
      const tid = (await knownTemplate(b.templateId)) || (newTemplateId ? await knownTemplate(newTemplateId) : '');
      const c = await provider.createCampaign({ subject, previewText: clip(b.previewText, 150).trim(), title: clip(b.title, 100).trim(), html, to: parseTo(b.to), ...(tid ? { templateId: tid } : {}) });
      return json(200, { campaign: c, ...(warnings.length ? { warnings } : {}) });
    }
    if (id && !action) {
      if (method === 'GET') return json(200, { campaign: await provider.getCampaign(id) });
      if (method === 'PATCH') {
        const b = await readBody(request); await draftOnly(id, 'change it');
        const f = {};
        if (typeof b.subject === 'string') { if (!b.subject.trim()) throw new HubError('An email needs a subject line.'); f.subject = clip(b.subject, 150).trim(); }
        if (typeof b.previewText === 'string') f.previewText = clip(b.previewText, 150).trim();
        if (typeof b.title === 'string' && b.title.trim()) f.title = clip(b.title, 100).trim();
        if (b.templateId !== undefined) { need('templateChange'); if (b.templateId === '' || b.templateId == null) throw new HubError('Choose a template.'); f.templateId = await knownTemplate(b.templateId); }
        if (b.layoutValues && typeof b.layoutValues === 'object') {   // the fields of an email made from a layout: re-render the whole email
          const kept = layoutsOn() ? await store.getLayout(id) : null, lay = kept && layouts[kept.layout];
          if (!lay) throw new HubError('That email was not made from a layout, so it has no fields to edit.', 409);
          const values = cleanValues(lay, b.layoutValues);
          f.html = renderLayout(lay, values, await layoutCtx());
          const campaign = await provider.updateCampaign(id, f);
          await store.saveLayout(id, kept.layout, values);
          return json(200, { campaign });
        }
        if (!Object.keys(f).length) throw new HubError('Nothing to change.');
        return json(200, { campaign: await provider.updateCampaign(id, f) });
      }
      if (method === 'DELETE') { const c = await draftOnly(id, 'delete it'); await provider.deleteCampaign(id); try { await store?.deleteLayout?.(id); } catch { /* the values are only useful with the email */ } return json(200, { ok: true, id: c.id }); }
    }
    if (id && action === 'content' && method === 'GET') {
      const c = await provider.campaignContent(id);
      const t = pickTemplate(templates, c.template, defaultTemplate);
      if (!t || !c.html) return json(200, c);
      const style = await loadStyle();
      return json(200, { ...c, template: t.name, designed: renderTemplate(t.html, { message: c.html, address: style.address || brand.address || '' }) });
    }
    if (id && action === 'report' && method === 'GET') { need('report'); return json(200, await provider.campaignReport(id)); }
    if (id && action === 'checklist' && method === 'GET') { need('checklist'); return json(200, await provider.sendChecklist(id)); }
    if (id && action === 'layout' && method === 'GET') {
      const one = layoutsOn() ? await store.getLayout(id) : null;
      return json(200, one && layouts[one.layout] ? { layout: one.layout, values: one.values, label: layouts[one.layout].label } : { layout: null });
    }
    if (id && action === 'duplicate' && method === 'POST') {
      const made = await provider.duplicateCampaign(id);
      try { await store?.copyLayout?.(id, made.id); } catch { /* the copy is still a good email, only its fields are not editable */ }   // the copy keeps the fields, so it can be changed by editing them
      return json(200, { campaign: made });
    }
    if (id && action === 'schedule' && method === 'POST') {
      const b = await readBody(request);
      const plan = planSchedule(b.sendAt, b.confirm, now(), rules);
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
    // The service has sent nothing in the period: use the emails kept from the previous provider (the archive) so the figures are
    // not blank, and say so. Once the service has sends of its own in a period, those are the only ones used.
    let kept = [];
    try { kept = store?.listArchive ? await store.listArchive() : []; } catch { kept = []; }
    const asFraction = (v) => (v == null ? null : Number(v) > 1 ? Number(v) / 100 : Number(v));
    const keptRows = kept.map((r) => ({ status: 'sent', when: r.sentAt, sent: r.emailsSent, openRate: asFraction(r.openRate), clickRate: asFraction(r.clickRate) }));
    const emailStats = (days) => {
      const own = emailsIn(all, days, t);
      if (own.emails || !keptRows.length) return { ok: true, data: own };
      const old = emailsIn(keptRows, days, t);
      return old.emails ? { ok: true, data: { ...old, fromArchive: kept[0].source } } : { ok: true, data: own };
    };
    return { connected: true, dc: list.dc, audience, campaigns: all, counts, growth30: g30, growth90: g90, email30: emailStats(30), email90: emailStats(90) };
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
      const person = { email: String(b.email).trim().toLowerCase(), first: clip(b.first, 80).trim(), last: clip(b.last, 80).trim() };
      const added = await provider.addContact({ ...person, tag: clip(b.tag, 100).trim() });
      // A note means the service kept somebody who had unsubscribed unsubscribed: core must not be told they consented.
      if (people && !added?.note) await quietly(() => people.subscribe(person), 'subscribe sync');
      return json(200, added);
    }
    if (id && !sub && method === 'GET') return json(200, await provider.contact(id));
    if (id && sub === 'tags' && (method === 'POST' || method === 'DELETE')) {
      const name = clip((await readBody(request)).name, 100).trim();
      if (!name) throw new HubError('Choose a tag.');
      return json(200, await provider.tagContact(id, name, method === 'POST'));
    }
    if (id && sub === 'unsubscribe' && method === 'POST') {
      // Kit and Mailchimp address a contact by id, so the address is read first, to tell core who left.
      const who = people ? await provider.contact(id).catch(() => null) : null;
      const out = await provider.unsubscribeContact(id);
      if (people && who?.email) await quietly(() => people.unsubscribe(who.email), 'unsubscribe sync');
      return json(200, out);
    }
    return json(405, { error: 'That is not something we do.' });
  }

  /* Logo uploads and the archive of a previous provider's emails. Only when the store offers them. */
  async function extras(request, path, method) {
    /* Suggested copy for a layout, from the host's own data: a list to choose from, then the values for one choice. Read-only; the person
       reviews what it fills in before anything is saved. Values go through the same cleaning as typed ones. */
    const src = /^\/layouts\/([a-z][a-z0-9-]{0,29})\/source(?:\/([A-Za-z0-9_.:-]{1,80}))?$/.exec(path);
    if (src && method === 'GET') {
      const lay = layouts?.[src[1]];
      if (!lay?.source || typeof lay.source.list !== 'function' || typeof lay.source.get !== 'function') throw new HubError('There is nothing to pull copy from for that.', 404);
      if (!src[2]) {
        const items = ((await lay.source.list()) || []).slice(0, 100).map((i) => ({ id: String(i.id).slice(0, 80), label: clip(i.label, 160), note: clip(i.note || '', 80) }));
        return json(200, { label: String(lay.source.label || 'Suggest copy').slice(0, 80), items });
      }
      const got = await lay.source.get(src[2]);
      if (!got) throw new HubError('That one could not be found.', 404);
      return json(200, { values: cleanValues(lay, got.values, { partial: true }), subject: clip(got.subject || '', 150), previewText: clip(got.previewText || '', 150) });
    }
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
    const isExtra = /^\/(look\/logos|archive|layouts\/[a-z][a-z0-9-]*\/source)(\/|$)/.test(path);
    const m = isExtra ? null : ROUTE.exec(path);
    if (!m && !isExtra) return null;
    const [, area, id, sub] = m || [];
    const url = new URL(request.url);
    try {
      if (area === 'config') return json(200, { newTemplateId: String(newTemplateId || ''), label: provider.label, capabilities: caps, brand: { name: brand.name || '' }, appUrl: provider.appUrl('/'), unsubscribePage: brand.unsubscribePage || null, schedule: rules, mergeTags: { unsubscribe: provider.mergeTags.unsubscribe, address: provider.mergeTags.address } });
      // Logos and the archive do not need the service to be connected (the archive outlives it).
      if (isExtra) return (await extras(request, path, method)) || json(405, { error: 'That is not something we do.' });
      if (!provider.connected()) {
        if (method === 'GET') return json(200, { connected: false, campaigns: [], tags: [], segments: [], label: provider.label });
        throw new HubError(`${provider.label} is not connected yet.`, 503);
      }
      if (area === 'overview' && method === 'GET') return json(200, await overview());
      if (area === 'audience' && method === 'GET' && !id) return json(200, { connected: true, ...(await provider.audience()) });
      if (area === 'layouts') return await layoutRoutes(request, method, id, sub);
      if (area === 'campaigns') return await campaigns(request, method, id, sub);
      if (area === 'contacts') return await contacts(request, url, method, id, sub);
      if (area === 'tags' && method === 'POST') { need('tags'); const n = clip((await readBody(request)).name, 100).trim(); if (!n) throw new HubError('Give the tag a name.'); return json(200, await provider.createTag(n)); }
      if (area === 'templates' && method === 'GET' && id && sub === 'preview') {   // a template as it looks around a sample message, from the host's copy
        need('templates');
        const found = ((await provider.listTemplates()).templates || []).find((t) => String(t.id) === String(id));
        if (!found) throw new HubError('That template is not in ' + provider.label + '.', 404);
        if (provider.templatePreview) {                     // the service can show one itself (Mailchimp keeps a picture of each)
          const own = await provider.templatePreview(id).catch(() => null);
          if (own && (own.imageUrl || own.html)) return json(200, { name: found.name, isDefault: Boolean(found.isDefault), url: found.url || null, imageUrl: own.imageUrl || null, html: own.html || null });
        }
        const copy = pickTemplate(templates, found.name);
        const style = await loadStyle();
        const address = style.address || brand.address || 'Your postal address';
        // The message shown inside the template: the host's own sample for THIS template when it gives one (a template that holds a whole
        // designed email is previewed around a sample of that email), else the host's general sample, else one plain sentence.
        const pick = typeof templateSample === 'function' ? templateSample(found.name, { style, address }) : (templateSample && typeof templateSample === 'object' ? templateSample[found.name] : templateSample);
        const message = (typeof pick === 'function' ? pick({ style, address }) : pick) || '<p style="font-family:Helvetica,Arial,sans-serif;font-size:17px;line-height:1.7;margin:0;">Your message appears here.</p>';
        // Two passes: the second fills the merge tags the message itself carries (its address line, its unsubscribe links).
        const html = copy ? renderTemplate(renderTemplate(copy.html, { message, address }), { message: '', address }) : null;
        // `bare`: what is shown has no background of its own, so it is a few words on a plain page. The screens then say so.
        return json(200, { name: found.name, isDefault: Boolean(found.isDefault), url: found.url || null, bare: Boolean(html && !/background|bgcolor/i.test(html)), html });
      }
      if (area === 'templates' && method === 'GET') { need('templates'); return json(200, await provider.listTemplates()); }
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
  const unsubscribe = (input) => handleUnsubscribe(provider, input, { people });
  return { handle, provider, capabilities: caps, loadStyle, unsubscribe };
}
