import { tableNames, ORDER_OLDEST_FIRST, isUuid, uuidFor, canonicalId, toSqlTime, fromSqlTime, parseReactionList, DEFAULT_REACTIONS } from './helpers.js';
let pass = 0, fail = 0; const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };

console.log('table names:');
ck('every table carries the self-scoped stem', tableNames().post === 'engine9_message_board_post' && tableNames().idea_comment === 'engine9_message_board_idea_comment');
ck('an optional prefix goes in front of the stem', tableNames('x_').post === 'x_engine9_message_board_post');
ck('all nine tables are named', Object.keys(tableNames()).length === 9);
ck('null is the same as no prefix', tableNames(null).reaction === 'engine9_message_board_reaction');
ck('ties are broken by insertion order', ORDER_OLDEST_FIRST === 'created_at, rowid');

console.log('\nids:');
ck('the same input is the same uuid', uuidFor('k1a') === uuidFor('k1a'));
ck('different inputs differ', uuidFor('k1a') !== uuidFor('k1b'));
ck('it reads as a version 5 uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidFor('anything')));
ck('a uuid is recognised', isUuid('3b4a0048-3193-4f11-80a8-bd5beb6aeea9') && !isUuid('k1a') && !isUuid(null));
const u = '3B4A0048-3193-4F11-80A8-BD5BEB6AEEA9';
ck('a uuid is kept, lower-cased', canonicalId(u) === u.toLowerCase());
ck('anything else is mapped', canonicalId('k1a') === uuidFor('k1a'));
ck('mapping is idempotent', canonicalId(canonicalId('k1a')) === canonicalId('k1a'));
ck('the mapping is stable across versions: a known input gives a known uuid', uuidFor('k1a') === '3d182a19-35c4-5be0-9f92-3efba87229eb', uuidFor('k1a'));

console.log('\ntime:');
ck('milliseconds survive the round trip', fromSqlTime(toSqlTime(1790000120500)) === 1790000120500);
ck('the text is a UTC datetime with a fraction', toSqlTime(1790000120500) === '2026-09-21 14:15:20.500');
ck('SQLite CURRENT_TIMESTAMP text is read as UTC', fromSqlTime('2026-09-21 14:15:20') === Date.parse('2026-09-21T14:15:20Z'));
ck('an explicit zone is respected', fromSqlTime('2026-09-21T14:15:20+02:00') === Date.parse('2026-09-21T12:15:20Z'));
ck('nothing or nonsense is 0', fromSqlTime('') === 0 && fromSqlTime('garbage') === 0 && fromSqlTime(null) === 0);

console.log('\nreactions:');
ck('a comma list is split and trimmed', parseReactionList(' 👍 , ❤️ ,🔥').join('') === '👍❤️🔥');
ck('empty falls back', parseReactionList('').join('') === DEFAULT_REACTIONS.join('') && parseReactionList(undefined).length === 5);
ck('a custom fallback is used', parseReactionList('', ['x']).join() === 'x');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
