import assert from 'node:assert/strict';
import { createEmailHub } from './routes.js';
import { createMemoryProvider } from './adapters/memory.js';

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const day = (d) => new Date(NOW - d * 86400_000).toISOString();
const overview = (hub) => hub.handle(new Request('https://x/overview'), '/overview', 'GET').then(async (r) => ({ status: r.status, body: await r.json() }));
const kept = [
  { source: 'mailchimp', id: 'a', sentAt: day(7), emailsSent: 500, openRate: 18.5, clickRate: 1.8 },
  { source: 'mailchimp', id: 'b', sentAt: day(20), emailsSent: 100, openRate: 30, clickRate: 5 },
  { source: 'mailchimp', id: 'c', sentAt: day(60), emailsSent: 400, openRate: 10, clickRate: 1 }
];
const store = { listArchive: async () => kept };

console.log('email figures before the service has sent anything');
{
  const hub = createEmailHub({ provider: createMemoryProvider(), store, now: () => NOW });
  const r = await overview(hub);
  assert.equal(r.status, 200);
  const e30 = r.body.email30.data, e90 = r.body.email90.data;
  assert.equal(e30.emails, 2); assert.equal(e30.sent, 600); assert.equal(e30.fromArchive, 'mailchimp'); ok('30 days comes from the kept emails, and says where from');
  assert.ok(Math.abs(e30.openRate - (0.185 * 500 + 0.30 * 100) / 600) < 1e-9); ok('rates are weighted by how many each email went to, as fractions');
  assert.equal(e90.emails, 3); assert.equal(e90.sent, 1000); ok('90 days includes the older one');
}
console.log('once the service has sent its own');
{
  const provider = createMemoryProvider();
  const made = await provider.createCampaign({ subject: 'S', previewText: '', title: 't', html: '<p>x</p>', to: {} });
  const own = { emails: 1, sent: 40, openRate: 0.5, clickRate: 0.1 };
  const hub = createEmailHub({ provider: { ...provider, listCampaigns: async () => ({ campaigns: [{ id: String(made.campaign?.id || made.id), status: 'sent', when: day(2), sent: 40, openRate: 0.5, clickRate: 0.1 }] }) }, store, now: () => NOW });
  const r = await overview(hub);
  assert.deepEqual({ ...r.body.email30.data }, own); assert.equal(r.body.email30.data.fromArchive, undefined); ok('its own numbers are the only ones used, no note');
}
console.log('with no archive at all');
{
  const r = await overview(createEmailHub({ provider: createMemoryProvider(), now: () => NOW }));
  assert.equal(r.body.email30.data.sent, 0); assert.equal(r.body.email30.data.fromArchive, undefined); ok('nothing changes');
  const bad = await overview(createEmailHub({ provider: createMemoryProvider(), store: { listArchive: async () => { throw new Error('db'); } }, now: () => NOW }));
  assert.equal(bad.status, 200); ok('an archive that cannot be read does not break the overview');
}
console.log(`\n${n} passed`);
