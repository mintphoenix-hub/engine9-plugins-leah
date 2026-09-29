/*
  Small pure helpers every host of the board ends up writing. They live here so hosts agree.

  No I/O, no globals: they run unchanged in a browser, a Worker and Node.
*/

/* ---- table names ------------------------------------------------------------------------ */

const BASE_TABLES = ['post', 'reaction', 'mention', 'post_tag', 'tag_follow', 'read_marker', 'idea', 'idea_vote', 'idea_comment'];

/* The deployed table names. Every table is self-scoped with the stem `engine9_message_board_` and the
   plugin sets no metadata.prefix, so core's plugin.table_prefix is empty and these names are final.
   Keyed by the short name: tableNames().post === 'engine9_message_board_post'. `prefix` is only for a
   host that copies the tables under another name of its own; leave it out otherwise. */
export const TABLE_STEM = 'engine9_message_board_';

export function tableNames(prefix = '') {
  const p = prefix == null ? '' : String(prefix);
  return Object.fromEntries(BASE_TABLES.map((t) => [t, `${p}${TABLE_STEM}${t}`]));
}

/* Read a thread oldest first, and make ties stable. `created_at` is a SQLite datetime, which is
   whole seconds by default, so rows written together (several reactions, a post and its first
   reply) share a value. `rowid` is insertion order, which breaks the tie the way people expect.
   Use it wherever the order is shown: reactions, votes, comments, posts. */
export const ORDER_OLDEST_FIRST = 'created_at, rowid';

/* ---- ids -------------------------------------------------------------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID.test(String(v ?? ''));

const fnv = (s, seed) => {
  let h = seed;
  for (const ch of s) { h ^= BigInt(ch.codePointAt(0)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h;
};

/* The same input always gives the same uuid (version 5 layout, so it reads as a uuid everywhere).
   Two FNV-1a 64-bit hashes make the 128 bits. It is for mapping an id a system already has onto
   the plugin's `id_uuid`, not for secrecy. */
export function uuidFor(seed) {
  const s = String(seed ?? '');
  const hex = fnv(s, 0xcbf29ce484222325n).toString(16).padStart(16, '0') + fnv(`b:${s}`, 0x84222325cbf29ce4n).toString(16).padStart(16, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/* An id a host already has, as the plugin's id: a uuid is kept (lower-cased), anything else is
   mapped deterministically. Idempotent, so a client still holding its own id and a server that
   has already stored the row agree on which row it is, and a retried write cannot double. */
export const canonicalId = (id) => (isUuid(id) ? String(id).toLowerCase() : uuidFor(id));

/* ---- time ------------------------------------------------------------------------------- */

/* Epoch milliseconds <-> the plugin's datetime text, "YYYY-MM-DD HH:MM:SS.mmm" in UTC. The
   milliseconds are kept as a fraction, so a host that sorts on them loses nothing. */
export const toSqlTime = (ms) => new Date(Number(ms) || Date.now()).toISOString().replace('T', ' ').replace('Z', '');

/* Text without a zone is read as UTC (that is what SQLite's CURRENT_TIMESTAMP writes). */
export function fromSqlTime(text) {
  if (!text) return 0;
  const s = String(text);
  const t = Date.parse(`${s.replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'}`);
  return Number.isNaN(t) ? 0 : t;
}

/* ---- reactions -------------------------------------------------------------------------- */

export const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀'];

/* The `reaction_emoji` setting is one comma-separated string. Returns the list, or `fallback`
   when the setting is missing or empty. Validate incoming reactions against it. */
export function parseReactionList(value, fallback = DEFAULT_REACTIONS) {
  const list = String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

export default { TABLE_STEM, tableNames, ORDER_OLDEST_FIRST, isUuid, uuidFor, canonicalId, toSqlTime, fromSqlTime, DEFAULT_REACTIONS, parseReactionList };
