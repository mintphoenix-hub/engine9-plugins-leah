import assert from 'node:assert/strict';
import { pickTemplate, renderTemplate } from './templates.js';
import { createEmailHub } from './routes.js';
import { createMemoryProvider } from './adapters/memory.js';

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
console.log(`\n${n} passed`);
