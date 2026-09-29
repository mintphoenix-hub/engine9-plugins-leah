import { EVERYONE_TAG, isEveryone, everyoneMentionRows, notificationPlan, notificationText, unreadBadgeSql } from './notifications.js';
import { mentionRows } from './mentions.js';
let pass = 0, fail = 0; const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };

console.log('everyone:');
ck('no audience is everyone', isEveryone(null) && isEveryone(undefined) && isEveryone([]));
ck('stored JSON is read', isEveryone('null') && isEveryone('[]') && isEveryone('') && !isEveryone('[3,4]'));
ck('an audience is not everyone', !isEveryone([3]));
{
  const rows = everyoneMentionRows('p1', { audience: null, everyoneIds: [1, 2, 3, 4], alreadyNotified: new Set([3]), authorPersonId: 1 });
  ck('skips the author and anyone already told', rows.map((r) => r.person_id).join() === '2,4', rows.map((r) => r.person_id).join());
  ck('written via @everyone', rows.every((r) => r.via_tag === EVERYONE_TAG));
  ck('a post with an audience writes none', everyoneMentionRows('p1', { audience: [2], everyoneIds: [1, 2] }).length === 0);
  ck('nobody in everyone writes none', everyoneMentionRows('p1', {}).length === 0);
}

console.log('\nplan:');
{
  const rows = [
    ...mentionRows('p1', [7]),
    ...everyoneMentionRows('p1', { everyoneIds: [7, 8, 9], alreadyNotified: new Set([7]) }),
    { post_id: 'p1', person_id: 10, via_tag: '#launch' },
  ];
  const plan = notificationPlan(rows, {});
  ck('default everyone: only the named get a push', plan.push.map((p) => p.person_id).join() === '7', plan.push.map((p) => p.person_id).join());
  ck('default everyone still raises the badge, as does a topic follower', plan.badge.join() === '7,8,9,10', plan.badge.join());
  const tagged = notificationPlan(rows, {}, { everyoneTagged: true });
  ck('an explicit @everyone pushes everyone', tagged.push.map((p) => p.person_id).join() === '7,8,9', tagged.push.map((p) => p.person_id).join());
  ck('a topic follower gets no push either way', !tagged.push.some((p) => p.person_id === 10));
  ck('via_tag kept for the text', tagged.push.find((p) => p.person_id === 7).via_tag === null && tagged.push.find((p) => p.person_id === 8).via_tag === '@everyone');
  const noEveryone = notificationPlan(rows, { everyone_notifications: false }, { everyoneTagged: true });
  ck('everyone_notifications off skips them', noEveryone.badge.join() === '7,10' && noEveryone.push.map((p) => p.person_id).join() === '7');
  const noMention = notificationPlan(rows, { mention_notifications: 'false' }, { everyoneTagged: true });
  ck('mention_notifications off skips the named (text setting)', !noMention.badge.includes(7) && noMention.push.map((p) => p.person_id).join() === '8,9');
  const noPush = notificationPlan(rows, { push_notifications: false }, { everyoneTagged: true });
  ck('push off leaves the badge', noPush.push.length === 0 && noPush.badge.length === 4);
  const noBadge = notificationPlan(rows, { badge_notifications: false }, { everyoneTagged: true });
  ck('badge off leaves the push', noBadge.badge.length === 0 && noBadge.push.length === 3);
  ck('a person is planned once', notificationPlan([{ person_id: 5, via_tag: null }, { person_id: 5, via_tag: '@everyone' }], {}, { everyoneTagged: true }).push.length === 1);
}

console.log('\ntext:');
ck('named', notificationText({ author_name: 'Ada', body: 'hi @Alan' }, null).title === 'Ada mentioned you');
ck('everyone', notificationText({ author_name: 'Ada', body: 'x' }, '@everyone').title === 'Ada posted to everyone');
ck('a group', notificationText({ author_name: 'Ada', body: 'x' }, '@managers').title === 'Ada posted to @managers');
ck('no author name', notificationText({ body: 'x' }, null).title === 'Someone mentioned you');
ck('one line', notificationText({ author_name: 'A', body: 'a\n\n  b' }).body === 'a b');
{ const t = notificationText({ author_name: 'A', body: 'x'.repeat(300) }, null, 50); ck('cut with an ellipsis', t.body.length === 50 && t.body.endsWith('…')); }

console.log('\nbadge sql:');
ck('reads the mention and post tables', /engine9_message_board_mention m JOIN engine9_message_board_post p/.test(unreadBadgeSql()));
ck('excludes deleted and own posts', /deleted_at IS NULL/.test(unreadBadgeSql()) && /p\.person_id <> :me/.test(unreadBadgeSql()));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
