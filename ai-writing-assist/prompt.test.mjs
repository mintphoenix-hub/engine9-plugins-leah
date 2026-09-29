import { BASE_INSTRUCTIONS, DEFAULT_FLAGS, flagWording, tidy, buildMessages, readReply } from './prompt.js';
let pass = 0, fail = 0; const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };

console.log('wording flags:');
ck('cure, treat, diagnose, guarantee are flagged', ['cure', 'treat / treatment', 'diagnose', 'guarantee'].every((l) => flagWording('It will cure you, treat pain, diagnose things and guarantee it.').includes(l)));
ck('says it heals a condition', flagWording('Sessions heal your anxiety').includes('says it heals a condition'));
ck('plain wording is not flagged', flagWording('Many people find a session calming, and some notice they sleep a little better.').length === 0);
ck('each label appears once', flagWording('cure cure cured').length === 1);
ck('"secure" and "obscure" are not "cure"', flagWording('a secure, obscure place').length === 0);
ck('"prevention" alone is not flagged, "prevents" is', flagWording('a prevention plan').length === 0 && flagWording('this prevents colds').includes('prevent'));
ck('a host can pass its own list', flagWording('fizzbuzz', [[/fizz/i, 'fizz']]).join() === 'fizz');
ck('the default list is a list of [RegExp, label]', DEFAULT_FLAGS.every(([re, l]) => re instanceof RegExp && typeof l === 'string'));
ck('nothing or undefined is fine', flagWording(undefined).length === 0 && flagWording('').length === 0);

console.log('\ntidy:');
ck('a lead-in line is removed', tidy('Here is a warmer version:\n\nHello there.') === 'Hello there.');
ck('"Sure!" is removed', tidy('Sure!\n\nHello there.') === 'Hello there.');
ck('a code fence is removed', tidy('```\nHello there.\n```') === 'Hello there.');
ck('wrapping quotes are removed', tidy('"Hello there."') === 'Hello there.');
ck('quotes inside are kept', tidy('She said "hello" and left.') === 'She said "hello" and left.');
ck('quoted pair inside is not stripped', tidy('"One" and "two"') === '"One" and "two"');
ck('an ordinary answer is untouched', tidy('  Hello there.\n\nSecond paragraph.  ') === 'Hello there.\n\nSecond paragraph.');
ck('empty stays empty', tidy(null) === '' && tidy(undefined) === '');

console.log('\nmessages:');
const rw = buildMessages({ mode: 'rewrite', instruction: 'warmer', text: 'Hello.', guide: 'Warm and plain.' });
ck('system then user', rw[0].role === 'system' && rw[1].role === 'user');
ck('the base rules are always there', rw[0].content.startsWith(BASE_INSTRUCTIONS));
ck('the host guide is added under the rules', rw[0].content.includes('Warm and plain.') && rw[0].content.indexOf('Warm and plain.') > BASE_INSTRUCTIONS.length);
ck('no guide means just the base rules', buildMessages({ mode: 'rewrite', text: 'x' })[0].content === BASE_INSTRUCTIONS);
ck('a huge guide is capped', buildMessages({ mode: 'rewrite', text: 'x', guide: 'g'.repeat(9000) })[0].content.length < BASE_INSTRUCTIONS.length + 4200);
ck('the request and the text are in the user message', rw[1].content.includes('warmer') && rw[1].content.includes('Hello.'));
ck('a selection is described as part of the piece', buildMessages({ mode: 'rewrite', text: 'x', hasSelection: true })[1].content.includes('this part of their piece'));
ck('no instruction still gives a default ask', buildMessages({ mode: 'rewrite', text: 'x' })[1].content.includes('Improve the flow'));
const dr = buildMessages({ mode: 'draft', instruction: 'about sleep', text: '' });
ck('a draft from a brief has no notes section', dr[1].content.includes('about sleep') && !dr[1].content.includes('Their notes'));
ck('a draft from notes includes them', buildMessages({ mode: 'draft', text: 'point one' })[1].content.includes('point one'));
ck('the base rules speak of "they", never a named writer or business', /\bthey\b/i.test(BASE_INSTRUCTIONS) && !/\b(Inc|Ltd|Pty)\b/.test(BASE_INSTRUCTIONS));

console.log('\nreading an answer:');
ck('{ response }', readReply({ response: 'a' }) === 'a');
ck('{ result: { response } }', readReply({ result: { response: 'b' } }) === 'b');
ck('OpenAI style', readReply({ choices: [{ message: { content: 'c' } }] }) === 'c');
ck('{ output_text }', readReply({ output_text: 'd' }) === 'd');
ck('nothing', readReply(null) === '' && readReply({}) === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
