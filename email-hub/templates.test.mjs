import assert from 'node:assert/strict';
import { pickTemplate, renderTemplate } from './templates.js';
import { createEmailHub } from './routes.js';
import { createMemoryProvider } from './adapters/memory.js';
import { createMailchimpProvider } from './adapters/mailchimp.js';
import { capabilitiesOf } from './provider.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const call = (hub, path) => hub.handle(new Request('https://x' + path), path, 'GET').then(async (r) => ({ status: r.status, body: await r.json() }));
const T = '<html><body>{{ message_content }}|{{ address }}|{{ subscriber.email_address }}|{{ unsubscribe_url }}|{{ nope }}</body></html>';

console.log('templates');
{
  assert.equal(pickTemplate(null, 'x'), null); ok('no templates means none');
  assert.equal(pickTemplate({ A: T }, ' a ').name, 'A'); ok('names match ignoring case and space');
  assert.equal(pickTemplate({ A: T, B: T }, 'zzz', 'b').name, 'B'); ok('the default covers an unknown name');
  assert.equal(pickTemplate({ A: T }, 'zzz'), null); ok('an unknown name with no default is none');
  assert.equal(pickTemplate({ A: '  ' }, 'A'), null); ok('an empty template is ignored');
  const out = renderTemplate(T, { message: '<p>Hi</p>', address: '1 Main St' });
  assert.equal(out, '<html><body><p>Hi</p>|1 Main St|you@example.org|#|</body></html>'); ok('merge tags are filled and unknown ones left empty');
  assert.ok(!/\{\{/.test(renderTemplate('{{ message_content }}{{x}}', { message: 'a' }))); ok('no raw braces survive');
}

console.log('the content route');
{
  const provider = createMemoryProvider();
  const made = await provider.createCampaign({ subject: 'S', previewText: '', title: 't', html: '<p>Body</p>', to: {} });
  const id = made.campaign?.id || made.id;
  const plain = createEmailHub({ provider });
  const a = await call(plain, `/campaigns/${id}/content`);
  assert.equal(a.body.designed, undefined); ok('without templates the content is unchanged');
  const hub = createEmailHub({ provider, templates: { House: T }, defaultTemplate: 'house', brand: { address: '2 Side St' } });
  const b = await call(hub, `/campaigns/${id}/content`);
  assert.equal(b.status, 200);
  assert.ok(b.body.designed.includes('<p>Body</p>|') && b.body.designed.includes('2 Side St')); ok('a template wraps the message');
  assert.equal(b.body.html, '<p>Body</p>'); assert.equal(b.body.template, 'House'); ok('the raw message and the template name still come back');
}

console.log('choosing a template');
{
  const provider = createMemoryProvider();
  const post = (hub, method, path, body) => hub.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, method).then(async (r) => ({ status: r.status, body: await r.json() }));
  const hub = createEmailHub({ provider, templates: { Designed: '<html><body>DESIGN {{ message_content }} {{ address }}</body></html>' }, brand: { address: '1 Main St' } });
  const made = await post(hub, 'POST', '/campaigns', { subject: 'S', text: 'Hello there', templateId: 't2' });
  assert.equal(made.status, 200); const id = made.body.campaign.id;
  assert.equal((await post(hub, 'GET', `/campaigns/${id}/content`)).body.templateId, 't2'); ok('a new email can be made in a chosen template');
  const other = await post(hub, 'POST', '/campaigns', { subject: 'S2', text: 'Hello again' });
  assert.equal((await post(hub, 'GET', `/campaigns/${other.body.campaign.id}/content`)).body.templateId, 't1'); ok('and otherwise uses the default');
  assert.equal((await post(hub, 'POST', '/campaigns', { subject: 'S', text: 'x', templateId: 'nope' })).status, 422); ok('a template that does not exist is refused');
  const upd = await post(hub, 'PATCH', `/campaigns/${other.body.campaign.id}`, { templateId: 't2' });
  assert.equal(upd.status, 200);
  assert.equal((await post(hub, 'GET', `/campaigns/${other.body.campaign.id}/content`)).body.templateId, 't2'); ok('a draft can be moved to another template');
  assert.equal((await post(hub, 'PATCH', `/campaigns/${id}`, { templateId: '' })).status, 400); ok('but not to no template');
  const pv = await post(hub, 'GET', '/templates/t2/preview');
  assert.ok(pv.body.html.includes('DESIGN') && pv.body.html.includes('Your message appears here') && pv.body.html.includes('1 Main St')); ok('a template previews around a sample message, from the host\'s copy');
  const none = await post(hub, 'GET', '/templates/t1/preview');
  assert.equal(none.body.html, null); ok('one the host has no copy of says so, and does not guess');
  assert.equal((await post(hub, 'GET', '/templates/zzz/preview')).status, 404); ok('an unknown template is a 404');
}


console.log('Mailchimp templates');
{
  const calls = [];
  let sectionsFor = { 77: { std_content00: '' }, 88: {} };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (!/\.api\.mailchimp\.com$/.test(u.hostname)) return original(url, opts);
    const path = u.pathname.replace(/^\/3\.0/, ''), method = (opts.method || 'GET').toUpperCase(), body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, path, body });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (method === 'GET' && path === '/lists/L') return json({ campaign_defaults: { from_name: 'A', from_email: 'a@example.org' } });
    if (method === 'GET' && path === '/templates') return json({ templates: [{ id: 77, name: 'Newsletter', thumbnail: 'https://cdn.example/n.png' }, { id: 88, name: 'Fixed', thumbnail: null }] });
    if (method === 'GET' && /^\/templates\/\d+$/.test(path)) return json({ id: 77, name: 'Newsletter', thumbnail: 'https://cdn.example/n.png' });
    if (method === 'GET' && /default-content$/.test(path)) return json({ sections: sectionsFor[Number(path.split('/')[2])] || {} });
    if (method === 'POST' && path === '/campaigns') return json({ id: 'c1', web_id: 1, type: 'regular', status: 'save', settings: { subject_line: body.settings.subject_line }, recipients: {} });
    return json({});
  };
  try {
    const mc = createMailchimpProvider({ apiKey: 'a'.repeat(32) + '-us1', listId: 'L' });
    const list = await mc.listTemplates();
    assert.equal(list.templates[0].thumbnail, 'https://cdn.example/n.png'); ok('a Mailchimp template list carries its picture');
    assert.equal((await mc.templatePreview('77')).imageUrl, 'https://cdn.example/n.png'); ok('a template previews as the picture Mailchimp keeps');
    await mc.createCampaign({ subject: 'S', html: '<p>Hello</p>', to: {}, templateId: '77' });
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/campaigns/c1/content');
    assert.deepEqual(put.body, { template: { id: 77, sections: { std_content00: '<p>Hello</p>' } } }); ok('a new email is made in the chosen template, the message in its editable area');
    calls.length = 0;
    await assert.rejects(() => mc.createCampaign({ subject: 'S', html: '<p>x</p>', to: {}, templateId: '88' }), /no editable area/);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/campaigns/c1')); ok('a template with no editable area is refused, and the empty draft is removed');
    calls.length = 0;
    await mc.createCampaign({ subject: 'S', html: '<p>Plain</p>', to: {} });
    assert.deepEqual(calls.find((c) => c.method === 'PUT').body, { html: '<p>Plain</p>' }); ok('with no template the message is sent as before');
    assert.equal(capabilitiesOf(mc).templateChange, false); ok('Mailchimp cannot re-wrap a written draft, so the screens do not offer it');
    const hub = createEmailHub({ provider: mc });
    const call2 = (method, path, body) => hub.handle(new Request('https://x' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, method).then(async (r) => ({ status: r.status, body: await r.json() }));
    const pv = await call2('GET', '/templates/77/preview');
    assert.equal(pv.body.imageUrl, 'https://cdn.example/n.png'); ok('the hub serves that picture as the preview');
  } finally { globalThis.fetch = original; }
}

console.log(`\n${n} passed`);
