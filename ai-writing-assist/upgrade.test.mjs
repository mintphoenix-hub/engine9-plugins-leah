import { expectedSchema, upgradePlan, upgradeMessage, install } from './upgrade.js';
import plugin from './index.js';
let pass = 0, fail = 0; const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };

const [{ table, columns }] = expectedSchema();
console.log('plan:');
ck('the schema names the use table', table === 'engine9_ai_writing_assist_use' && columns.includes('day'));
ck('a complete database is up to date', upgradePlan({ [table]: columns }).upToDate === true);
ck('a missing table is reported', upgradePlan({}).missingTables[0] === table && upgradePlan({ [table]: null }).upToDate === false);
ck('a missing column is reported', (() => { const p = upgradePlan({ [table]: columns.filter((c) => c !== 'outcome') }); return p.missingColumns.length === 1 && p.missingColumns[0].column === 'outcome'; })());
ck('extra columns are ignored', upgradePlan({ [table]: [...columns, 'host_note'] }).upToDate === true);
ck('a future column is caught', upgradePlan({ [table]: columns }, [{ name: table, columns: { ...Object.fromEntries(columns.map((c) => [c, 1])), extra: 1 } }]).missingColumns[0].column === 'extra');
ck('messages say what is wrong', upgradeMessage(upgradePlan({})).includes(table) && upgradeMessage(upgradePlan({ [table]: columns })).includes('up to date'));

console.log('\ninstall hook:');
const fake = (have) => ({ async query({ sql }) { const m = sql.match(/^select (.+) from (\S+) limit 1$/); if (!have[m[2]] || (m[1] !== '1' && !have[m[2]].includes(m[1]))) throw new Error('no such'); return { data: [] }; } });
ck('core sees the hook on the default export', typeof plugin.install === 'function');
ck('up to date', (await install({ sqlWorker: fake({ [table]: columns }) })).message.includes('up to date'));
ck('a missing table is named', (await install({ sqlWorker: fake({}) })).message.includes(table));
ck('a missing column is named', (await install({ sqlWorker: fake({ [table]: ['id', 'day'] }) })).message.includes(`${table}.outcome`));
ck('no worker still answers with a message', typeof (await install()).message === 'string');
ck('a broken worker never throws', typeof (await install({ sqlWorker: { query() { throw new Error('x'); } } })).message === 'string');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
