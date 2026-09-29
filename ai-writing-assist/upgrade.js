/*
  Keeping the schema in step with engine9 core.

  Core diffs a plugin's schema and adds new settings every time the plugin is (re)installed, so an
  additive change ships by itself when the account reinstalls after a core or plugin update. This
  file adds the check on top: after core has deployed, `install` reads what the database really
  has, compares it with schema.js and says what, if anything, is still missing. It never runs DDL:
  DDL is core's job (standardizeSchema + buildCreateTable), and hand-written copies drift.

  `upgradePlan` is pure (no I/O) and runs anywhere. `install` is the hook core calls with
  `{ sqlWorker, account, plugin }`; it is the only function here that touches a database, and only
  through the worker core hands it. It never throws, so a check can never fail an install.
*/
import { tables as schemaTables } from './schema.js';

/* What a table must have, from schema.js: [{ table, columns: [names] }]. */
export function expectedSchema(tables = schemaTables) {
  return tables.map((t) => ({ table: t.name, columns: Object.keys(t.columns || {}) }));
}

/*
  Compare the deployed database with the schema. `found` maps a table name to its column names, or
  to null / leaves it out when the table does not exist.
  Returns { upToDate, missingTables: [table], missingColumns: [{ table, column }] }. Extra columns
  and tables are ignored: a host may add its own, and the published names are never dropped.
*/
export function upgradePlan(found = {}, tables = schemaTables) {
  const missingTables = [];
  const missingColumns = [];
  for (const { table, columns } of expectedSchema(tables)) {
    const have = found[table];
    if (!Array.isArray(have)) {
      missingTables.push(table);
      continue;
    }
    const names = new Set(have.map(String));
    for (const column of columns) if (!names.has(column)) missingColumns.push({ table, column });
  }
  return { upToDate: !missingTables.length && !missingColumns.length, missingTables, missingColumns };
}

/* One line for a person: what is wrong, or that nothing is. */
export function upgradeMessage(plan) {
  if (plan.upToDate) return 'AI writing assist: schema is up to date.';
  const parts = [];
  if (plan.missingTables.length) parts.push(`missing tables: ${plan.missingTables.join(', ')}`);
  if (plan.missingColumns.length) parts.push(`missing columns: ${plan.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ')}`);
  return `AI writing assist: schema needs attention (${parts.join('; ')}). Reinstall the plugin so core can deploy it.`;
}

/* Which columns of a table exist. A select of one column is the same on SQLite and MySQL, where the
   catalog queries are not. Returns null when the table is missing. */
async function columnsOf(sqlWorker, { table, columns }) {
  try {
    await sqlWorker.query({ sql: `select 1 from ${table} limit 1`, values: [] });
  } catch (e) {
    return null;
  }
  const have = [];
  for (const column of columns) {
    try {
      await sqlWorker.query({ sql: `select ${column} from ${table} limit 1`, values: [] });
      have.push(column);
    } catch (e) {
      /* absent */
    }
  }
  return have;
}

/* The hook core calls on every install and reinstall, after it has diffed and deployed the schema
   and settings. Always returns { message } (core reads it), and never throws. */
export async function install({ sqlWorker } = {}) {
  if (!sqlWorker || typeof sqlWorker.query !== 'function') return { message: 'AI writing assist: no database worker, schema not checked.' };
  try {
    const found = {};
    for (const t of expectedSchema()) found[t.table] = await columnsOf(sqlWorker, t);
    return { message: upgradeMessage(upgradePlan(found)) };
  } catch (e) {
    return { message: 'AI writing assist: schema check could not run.' };
  }
}
