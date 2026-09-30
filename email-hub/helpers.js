/*
  Small pure helpers every host of the email hub ends up writing. No I/O, no globals: they run unchanged
  in a browser, a Worker and Node.
*/

const BASE_TABLES = ['style', 'logo', 'archive'];

/* The deployed table names. Every table is self-scoped with the stem `engine9_email_hub_` and the plugin sets
   no metadata.prefix, so core's plugin.table_prefix is empty and these names are final. Keyed by the short name:
   tableNames().style === 'engine9_email_hub_style'. `prefix` is only for a host that copies the tables under
   another name of its own; leave it out otherwise. */
export const TABLE_STEM = 'engine9_email_hub_';

export function tableNames(prefix = '') {
  const p = prefix == null ? '' : String(prefix);
  return Object.fromEntries(BASE_TABLES.map((t) => [t, `${p}${TABLE_STEM}${t}`]));
}

/* An instant as the plugin's datetime text, "YYYY-MM-DD HH:MM:SS.mmm" in UTC. */
export const toSqlTime = (ms) => new Date(Number(ms) || Date.now()).toISOString().replace('T', ' ').replace('Z', '');

/* A count-based rate, one decimal, or null when either side is missing or the base is zero. Providers report
   their own percentage fields as a fraction in one place and a percentage in another; a wrong 0.19 reads as
   0.19%, so rates are computed from counts wherever counts exist. */
export const rate = (n, d) => (Number.isFinite(n) && Number.isFinite(d) && d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/* A number, or null for anything empty or not numeric (never 0 for "missing"). */
export const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/* The calendar day n days ago as YYYY-MM-DD (UTC). */
export const dayAgo = (n, now = Date.now()) => new Date(now - n * 86400000).toISOString().slice(0, 10);

/* Cut to a number of CHARACTERS, not UTF-16 halves, so an emoji at the limit is kept whole. */
export const cut = (s, max) => [...String(s ?? '').trim()].slice(0, max).join('');
