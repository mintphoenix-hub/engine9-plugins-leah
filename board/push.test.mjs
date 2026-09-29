/* Who hears about a post, what the push says, the device table's SQL, and sending. The SQL runs on a
   real SQLite (node:sqlite) against the columns the plugin's schema declares. */
import { DatabaseSync } from 'node:sqlite';
import { pushRecipients, pushMessage, subscriptionSql, buildPushes, sendPushes } from './push.js';
import { generateVapidKeys, b64u } from './webpush.js';
import { tableNames, canonicalId } from './helpers.js';
import { tables } from './schema.js';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };
const ids = (r) => r.map((x) => `${x.personId}:${x.kind}`).sort().join(' ');

console.log('who is told:');
{
  const everyone = [11, 12, 13, 21];
  ck('a new post tells everyone but the author', ids(pushRecipients({ authorPersonId: 11, everyone })) === '12:post 13:post 21:post');
  ck('an audience narrows it to the audience', ids(pushRecipients({ authorPersonId: 11, everyone, audience: [11, 13] })) === '13:post');
  ck('an empty audience means everyone', ids(pushRecipients({ authorPersonId: 11, everyone, audience: [] })) === '12:post 13:post 21:post');
  ck('a board that does not broadcast tells nobody about a top-level post', pushRecipients({ authorPersonId: 11, broadcast: false, everyone }).length === 0);
  ck('a reply tells the root author and earlier repliers, not the author', ids(pushRecipients({ authorPersonId: 13, isReply: true, threadPersonIds: [11, 12, 13] })) === '11:reply 12:reply');
  ck('a reply does not go to the whole team', !pushRecipients({ authorPersonId: 13, isReply: true, threadPersonIds: [11], everyone }).some((r) => r.personId === 12));
  const m = pushRecipients({ authorPersonId: 11, everyone, mentionedPersonIds: [12] });
  ck('a named person hears "mention" INSTEAD of the notice, once', ids(m) === '12:mention 13:post 21:post', ids(m));
  ck('naming yourself tells nobody', pushRecipients({ authorPersonId: 11, broadcast: false, mentionedPersonIds: [11] }).length === 0);
  ck('a mention outside the audience is not told', pushRecipients({ authorPersonId: 11, audience: [11, 13], mentionedPersonIds: [12] }).every((r) => r.personId !== 12));
  ck('reached by a tag, heard as a tag', ids(pushRecipients({ authorPersonId: 11, broadcast: false, taggedPersonIds: [13, 11] })) === '13:tag');
  ck('mention beats tag beats reply for one person', ids(pushRecipients({ authorPersonId: 11, isReply: true, threadPersonIds: [12, 13], mentionedPersonIds: [12], taggedPersonIds: [12, 13] })) === '12:mention 13:tag');
  ck('person 0 (no record) is never told', pushRecipients({ everyone: [0, 12] }).map((r) => r.personId).join() === '12');
  ck('junk ids are ignored', pushRecipients({ everyone: [12, 'x', -3, 1.5, null, '14'] }).map((r) => r.personId).join() === '12,14');
}

console.log('\nwhat it says:');
{
  ck('a mention', pushMessage('mention', { from: 'Ada', body: 'x' }).title === 'Ada mentioned you');
  ck('a reply', pushMessage('reply', { from: 'Ada', body: 'x' }).title === 'Ada replied');
  ck('a tag names it', pushMessage('tag', { from: 'Ada', body: 'x', tag: '@managers' }).title === 'Ada posted to @managers');
  ck('a general post names the board', pushMessage('post', { from: 'Ada', body: 'x', boardName: 'the team board' }).title === 'Ada posted on the team board');
  ck('and has a default board name', pushMessage('post', { from: 'Ada', body: 'x' }).title === 'Ada posted on the board');
  ck('no author name', pushMessage('mention', { body: 'x' }).title === 'Someone mentioned you');
  ck('one line, clipped for a lock screen', pushMessage('post', { from: 'A', body: 'a\n\n b' }).body === 'a b' && pushMessage('post', { from: 'A', body: 'a'.repeat(500) }).body.length === 140);
}

console.log('\nthe device table, on real SQLite:');
{
  const t = tableNames().push_subscription;
  ck('the table is in the plugin schema under the stem', tables.some((x) => x.name === t) && t === 'engine9_message_board_push_subscription');
  const decl = tables.find((x) => x.name === t);
  ck('endpoint is unique and person_id is indexed', decl.indexes.some((i) => i.columns === 'endpoint' && i.unique) && decl.indexes.some((i) => JSON.stringify(i.columns) === '["person_id"]'));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ${t} (id char(36) PRIMARY KEY, person_id bigint NOT NULL DEFAULT 0, endpoint varchar(512) NOT NULL, p256dh varchar(128) NOT NULL, auth varchar(64) NOT NULL, user_agent varchar(255), created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE UNIQUE INDEX ep ON ${t} (endpoint);`);
  const q = subscriptionSql();
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  run(q.save, canonicalId('e1'), 12, 'https://fcm.googleapis.com/e1', 'K1', 'A1', 'Chrome');
  run(q.save, canonicalId('e2'), 12, 'https://fcm.googleapis.com/e2', 'K2', 'A2', 'Safari');
  run(q.save, canonicalId('e3'), 13, 'https://fcm.googleapis.com/e3', 'K3', 'A3', 'Firefox');
  ck('save stores a device', all(q.count, 12)[0].n === 2 && all(q.count, 13)[0].n === 1);
  run(q.save, canonicalId('other'), 14, 'https://fcm.googleapis.com/e1', 'K1b', 'A1b', 'Chrome 2');
  ck('one endpoint is one row: a phone that changes hands follows its new owner', all(q.count, 12)[0].n === 1 && all(q.count, 14)[0].n === 1 && all(q.countDevice, 14, 'https://fcm.googleapis.com/e1')[0].n === 1);
  ck('a conflict keeps the original row id', all(`SELECT id FROM ${t} WHERE endpoint = ?`, 'https://fcm.googleapis.com/e1')[0].id === canonicalId('e1'));
  ck('and takes the new keys', all(`SELECT p256dh FROM ${t} WHERE endpoint = ?`, 'https://fcm.googleapis.com/e1')[0].p256dh === 'K1b');
  run(q.remove, 12, 'https://fcm.googleapis.com/e1');
  ck('remove needs the endpoint AND the owner: someone else cannot switch off your device', all(q.count, 14)[0].n === 1);
  run(q.remove, 14, 'https://fcm.googleapis.com/e1');
  ck('the owner can remove it', all(q.count, 14)[0].n === 0);
  const rows = all(q.forPersons(2), 12, 13);
  ck('forPersons returns the devices of exactly those people', rows.map((r) => r.endpoint).sort().join() === 'https://fcm.googleapis.com/e2,https://fcm.googleapis.com/e3');
  ck('forPersons builds one placeholder per person', (q.forPersons(3).match(/\?/g) || []).length === 3 && (q.forPersons(0).match(/\?/g) || []).length === 1);
  run(q.removeGone, 'https://fcm.googleapis.com/e2');
  ck('a gone endpoint is deleted', all(q.count, 12)[0].n === 0);
  ck('the mysql upsert says so', /ON DUPLICATE KEY UPDATE/.test(subscriptionSql('', 'mysql').save) && /ON CONFLICT/.test(q.save));
  ck('a prefix is honoured', /^INSERT INTO acme_engine9_message_board_push_subscription/.test(subscriptionSql('acme_').save));
}

console.log('\nbuilding and sending:');
{
  const subs = [
    { person_id: 12, endpoint: 'https://fcm.googleapis.com/a', p256dh: 'x', auth: 'y' },
    { person_id: 12, endpoint: 'https://fcm.googleapis.com/b', p256dh: 'x', auth: 'y' },
    { person_id: 13, endpoint: 'https://fcm.googleapis.com/c', p256dh: 'x', auth: 'y' },
    { person_id: 99, endpoint: 'https://fcm.googleapis.com/d', p256dh: 'x', auth: 'y' }
  ];
  const recipients = pushRecipients({ authorPersonId: 11, everyone: [11, 12, 13, 21], mentionedPersonIds: [12] });
  const pushes = buildPushes(recipients, subs, { from: 'Ada', body: 'read the plan', url: '/board', threadKey: 'root1', counts: new Map([[12, 3]]) });
  ck('one push per device of each person told, none for someone not told', pushes.map((p) => `${p.personId}:${p.subscription.endpoint.slice(-1)}`).join() === '12:a,12:b,13:c');
  ck('a mention is high urgency, a notice is normal', pushes.find((p) => p.personId === 12).urgency === 'high' && pushes.find((p) => p.personId === 13).urgency === 'normal');
  ck('the mentioned person hears "mentioned you"; the other hears the notice', pushes.find((p) => p.personId === 12).message.title === 'Ada mentioned you' && pushes.find((p) => p.personId === 13).message.title === 'Ada posted on the board');
  ck('pushes about one thread share a tag so they replace each other', pushes.every((p) => p.message.tag === 'board-root1'));
  ck('the url rides along, and the badge count only where known', pushes.every((p) => p.message.url === '/board') && pushes.find((p) => p.personId === 12).message.count === 3 && !('count' in pushes.find((p) => p.personId === 13).message));
  ck('a tag title uses that person’s tag', buildPushes([{ personId: 13, kind: 'tag' }], [subs[2]], { from: 'Ada', tagOf: { 13: '#launch' } })[0].message.title === 'Ada posted to #launch');

  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:ops@example.test' };
  const real = await (async () => {
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return { p256dh: b64u.encode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64u.encode(crypto.getRandomValues(new Uint8Array(16))) };
  })();
  const live = pushes.map((p) => ({ ...p, subscription: { ...p.subscription, ...real } }));
  const status = { a: 201, b: 410, c: 500 };
  const hits = [];
  const out = await sendPushes(live, vapid, { fetchImpl: async (url) => { hits.push(url); return { status: status[url.slice(-1)] }; } });
  ck('counts what was sent, what failed', out.sent === 1 && out.failed === 2, JSON.stringify({ sent: out.sent, failed: out.failed }));
  ck('returns the gone endpoint for the host to delete, nothing else', out.gone.join() === 'https://fcm.googleapis.com/b');
  ck('reports how many people, never who', out.people === 2 && !('recipients' in out));
  ck('one bad device does not stop the rest', hits.length === 3);
  const boom = await sendPushes(live, vapid, { fetchImpl: async () => { throw new Error('network'); } });
  ck('a thrown network error is a failure, not a crash', boom.sent === 0 && boom.failed === 3);
  ck('nothing to send is not an error', (await sendPushes([], vapid)).sent === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
