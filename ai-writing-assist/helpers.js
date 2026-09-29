/*
  Small pure helpers every host of AI writing assist ends up writing. No I/O, no globals: they run
  unchanged in a browser, a Worker and Node.
*/

/* ---- table names ------------------------------------------------------------------------ */

const BASE_TABLES = ['use'];

/* The deployed table names. Every table is self-scoped with the stem `engine9_ai_writing_assist_` and
   the plugin sets no metadata.prefix, so core's plugin.table_prefix is empty and these names are final.
   Keyed by the short name: tableNames().use === 'engine9_ai_writing_assist_use'. `prefix` is only for a
   host that copies the tables under another name of its own; leave it out otherwise. */
export const TABLE_STEM = 'engine9_ai_writing_assist_';

export function tableNames(prefix = '') {
  const p = prefix == null ? '' : String(prefix);
  return Object.fromEntries(BASE_TABLES.map((t) => [t, `${p}${TABLE_STEM}${t}`]));
}

/* ---- time ------------------------------------------------------------------------------- */

/* The calendar day (UTC) an instant falls on, "YYYY-MM-DD". Cloudflare's free Workers AI allowance
   resets at 00:00 UTC, and a daily limit is counted by this day. */
export const utcDay = (ms = Date.now()) => new Date(Number(ms) || Date.now()).toISOString().slice(0, 10);

/* An instant as the plugin's datetime text, "YYYY-MM-DD HH:MM:SS.mmm" in UTC. */
export const toSqlTime = (ms) => new Date(Number(ms) || Date.now()).toISOString().replace('T', ' ').replace('Z', '');
