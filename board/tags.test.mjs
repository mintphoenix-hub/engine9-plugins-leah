import { normalizeTag, parseHashtags, parseGroupTags, findTags, tagRows, tagMentionRows } from './tags.js';
let pass = 0, fail = 0; const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };
const GROUPS = ['managers', 'staff', 'everyone'];

console.log('normalising:');
ck('lower-cased, # dropped', normalizeTag('#Launch') === 'launch');
ck('accents folded', normalizeTag('Café') === 'cafe');
ck('must start with a letter', normalizeTag('#2026') === '' && normalizeTag('9lives') === '');
ck('junk stripped', normalizeTag('a b!c') === 'abc');
ck('capped at 40', normalizeTag('a'.repeat(80)).length === 40);

console.log('\n#topics:');
ck('a plain topic', parseHashtags('need #launch for Friday').join() === 'launch');
ck('once each, in order', parseHashtags('#budget and #launch and #budget').join() === 'budget,launch');
ck('case does not matter', parseHashtags('#Launch #LAUNCH').join() === 'launch');
ck('an HTML entity is not a topic', parseHashtags('it&#39;s fine').length === 0);
ck('a URL fragment is not a topic', parseHashtags('see example.com/page#top').length === 0);
ck('C# is not a topic', parseHashtags('we write in C# now').length === 0);
ck('a number is not a topic', parseHashtags('room #12').length === 0);
ck('hyphen and underscore stay in', parseHashtags('#set-pieces #run_sheet').join() === 'set-pieces,run_sheet');
ck('start of the text counts', parseHashtags('#launch first').join() === 'launch');

console.log('\n@group tags:');
ck('a group is found', parseGroupTags('@managers please read', GROUPS).join() === 'managers');
ck('two groups', parseGroupTags('@staff and @managers', GROUPS).sort().join() === 'managers,staff');
ck('an unknown @name is not a group', parseGroupTags('@nobody', GROUPS).length === 0);
ck('@managers does not fire inside @managersroom', parseGroupTags('@managersroom', GROUPS).length === 0);
ck('an email address is not a group', parseGroupTags('mail a@staff.com', GROUPS).length === 0);
ck('case does not matter', parseGroupTags('@Staff!', GROUPS).join() === 'staff');
ck('objects with a tag work too', parseGroupTags('@staff', [{ tag: 'staff' }]).join() === 'staff');

console.log('\nfinding them in the text:');
{
  const t = '@managers see #launch, and @Sam too';
  const f = findTags(t, GROUPS);
  ck('a group and a topic, no person', f.length === 2 && f[0].kind === 'group' && f[1].kind === 'topic');
  ck('positions slice back to the text', t.slice(f[0].start, f[0].end) === '@managers' && t.slice(f[1].start, f[1].end) === '#launch');
}

{
  const t = 'Cafe\u0301 news #launch for @managers';
  const spans = findTags(t, ['managers']);
  ck('tag spans line up after a separately typed accent', spans.map((x) => t.slice(x.start, x.end)).join() === '#launch,@managers', JSON.stringify(spans));
}
console.log('\nrows:');
ck('post_tag rows', tagRows('p1', { groups: ['staff'], topics: ['launch'] }).map((r) => `${r.kind}:${r.tag}`).join() === 'group:staff,topic:launch');
{
  const rows = tagMentionRows('p1', [
    { tag: 'managers', kind: 'group', personIds: [1, 2, 3] },
    { tag: 'launch', kind: 'topic', personIds: [3, 4] },
  ], { alreadyNotified: new Set([2]), authorPersonId: 1 });
  ck('the author and anyone already named are skipped', rows.map((r) => r.person_id).join() === '3,4', rows.map((r) => r.person_id).join());
  ck('reached twice, written once, under the first tag', rows.find((r) => r.person_id === 3).via_tag === '@managers');
  ck('a topic reads as #topic', rows.find((r) => r.person_id === 4).via_tag === '#launch');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
