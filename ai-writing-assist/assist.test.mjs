import { resolveSettings, planRequest, finishRequest, usageCountSql, usageInsertSql, MESSAGES, LIMITS } from './assist.js';
import { tableNames, utcDay, toSqlTime, TABLE_STEM } from './helpers.js';
import { tables } from './schema.js';
import { settings } from './settings.js';
let pass = 0, fail = 0; const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };

console.log('settings:');
ck('defaults when nothing is given', resolveSettings().daily_limit === 150 && resolveSettings({}).model.startsWith('@cf/'));
ck('a value is used', resolveSettings({ daily_limit: '40' }).daily_limit === 40);
ck('a number is clamped to the maximum', resolveSettings({ daily_limit: '999999' }).daily_limit === 2000);
ck('and to the minimum, so it cannot be switched off', resolveSettings({ daily_limit: '0' }).daily_limit === 1 && resolveSettings({ daily_limit: '-5' }).daily_limit === 1);
ck('nonsense falls back to the default', resolveSettings({ daily_limit: 'lots' }).daily_limit === 150);
ck('empty and null fall back', resolveSettings({ model: '', daily_limit: null }).daily_limit === 150 && resolveSettings({ model: '' }).model.startsWith('@cf/'));
ck('every setting in settings.js resolves', settings.every((s) => resolveSettings({})[s.name] !== undefined));

console.log('\nplanning a request:');
const S = { daily_limit: 3 };
const ok = (input, extra = {}) => planRequest(input, { settings: S, used: 0, ...extra });
ck('a rewrite needs text', ok({ mode: 'rewrite', text: '  ' }).status === 400 && ok({ mode: 'rewrite', text: '  ' }).error === MESSAGES.needText);
ck('a draft needs a brief or notes', ok({ mode: 'draft' }).status === 400 && ok({ mode: 'draft', instruction: 'about x' }).ok === true && ok({ mode: 'draft', text: 'notes' }).ok === true);
ck('mode defaults to rewrite', ok({ text: 'hello' }).mode === 'rewrite');
ck('too much text is refused, not cut', planRequest({ text: 'x'.repeat(600) }, { settings: { max_input_chars: 500 } }).status === 413);
ck('no AI binding is a 503', ok({ text: 'hi' }, { hasAi: false }).status === 503);
ck('the daily limit stops it, and says why', ok({ text: 'hi' }, { used: 3 }).status === 429 && ok({ text: 'hi' }, { used: 3 }).outcome === 'limit');
ck('just under the limit is fine', ok({ text: 'hi' }, { used: 2 }).ok === true);
ck('an ordinary request is planned', (() => { const p = ok({ text: 'hi', instruction: 'shorter' }, { guide: 'g' }); return p.ok && p.messages.length === 2 && p.model.startsWith('@cf/') && p.params.max_tokens > 0 && p.inputChars === 2; })());
ck('the guide reaches the prompt', ok({ text: 'hi' }, { guide: 'SITE-GUIDE' }).messages[0].content.includes('SITE-GUIDE'));
ck('the instruction is capped', ok({ text: 'hi', instruction: 'i'.repeat(5000) }).messages[1].content.length < 5000);
ck('line endings are normalised', !ok({ text: 'a\r\nb' }).messages[1].content.includes('\r'));

console.log('\nfinishing a request:');
const plan = ok({ text: 'hi' });
const good = finishRequest({ out: { response: 'Here is a version:\n\nA gentle line that will cure nothing.' } }, plan);
ck('a good answer is 200 with the tidied text', good.status === 200 && good.body.suggestion === 'A gentle line that will cure nothing.' && good.outcome === 'ok');
ck('and flags wording to look at', good.body.flags.includes('cure'));
ck('empty answers are reported as empty', finishRequest({ out: { response: '   ' } }, plan).outcome === 'empty' && finishRequest({ out: {} }, plan).status === 502);
ck('allowance errors become a "try tomorrow" answer', ['4006: you have used up your daily free allocation of 10,000 neurons', 'Too many requests', 'rate limit'].every((m) => { const r = finishRequest({ error: new Error(m) }, plan); return r.status === 429 && r.outcome === 'limit' && r.body.error === MESSAGES.usedUp; }));
ck('other errors are a 502 and keep the reason out of the answer', (() => { const r = finishRequest({ error: new Error('socket hang up at 10.0.0.1') }, plan); return r.status === 502 && r.outcome === 'error' && !JSON.stringify(r.body).includes('10.0.0.1') && r.detail.includes('socket'); })());
ck('a string error works too', finishRequest({ error: 'boom' }, plan).outcome === 'error');
ck('a host flag list is respected', finishRequest({ out: { response: 'fizz' } }, { flags: [[/fizz/i, 'fizz']] }).body.flags.join() === 'fizz');

console.log('\nusage rows:');
const day = utcDay(Date.UTC(2026, 8, 30, 23, 59));
ck('the day is UTC', day === '2026-09-30' && utcDay(Date.UTC(2026, 9, 1, 0, 0)) === '2026-10-01');
ck('the count query names the deployed table and the day', usageCountSql('2026-09-30').sql.includes('engine9_ai_writing_assist_use') && usageCountSql('2026-09-30').values[0] === '2026-09-30');
ck('only answered requests count against the limit', usageCountSql().sql.includes("IN ('ok','empty')") && !usageCountSql().sql.includes('limit'));
const ins = usageInsertSql({ mode: 'rewrite', model: 'm', inputChars: 12, outputChars: 34, outcome: 'ok', at: Date.UTC(2026, 8, 30, 1, 2, 3) });
ck('an insert has one value per column', (ins.sql.match(/\?/g) || []).length === ins.values.length && ins.values.length === 7);
ck('an insert derives the day and the time from the instant', ins.values[0] === '2026-09-30' && ins.values[6] === '2026-09-30 01:02:03.000');
ck('an insert stores lengths, not text', ins.values.filter((v) => typeof v === 'string').every((v) => v.length < 40));
ck('a prefix is honoured', usageCountSql('d', 'x_').sql.includes('x_engine9_ai_writing_assist_use'));

console.log('\nschema and names:');
ck('the table is self-scoped with the stem', tables.every((t) => t.name.startsWith(TABLE_STEM)));
ck('every table is named, and nothing else is', Object.keys(tableNames()).length === tables.length && tables.every((t) => Object.values(tableNames()).includes(t.name)));
ck('the columns the SQL writes all exist', ['day', 'mode', 'model', 'input_chars', 'output_chars', 'outcome', 'created_at'].every((c) => c in tables[0].columns));
ck('no column can hold what was written', !Object.keys(tables[0].columns).some((c) => /text|body|prompt|instruction|content|suggestion/.test(c)));
ck('created_at time text is UTC with a fraction', toSqlTime(Date.UTC(2026, 8, 30, 1, 2, 3, 400)) === '2026-09-30 01:02:03.400');
ck('the instruction limit is sensible', LIMITS.instruction >= 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
