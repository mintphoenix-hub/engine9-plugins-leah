/*
  Notifications: who gets a push and a badge for a post, and what the push says.

  Pure and storage-free, like mentions.js and tags.js. The plugin does not deliver anything; the
  host sends the push and draws the badge. What lives here is the part every host would
  otherwise decide for itself:

    - a post is to EVERYONE when it has no audience (audience_person_ids null or empty), which
      is the default. Everyone is a group the host defines, so it is passed in as person ids;
    - each person told is one `mention` row: `via_tag` null when named directly, '@everyone'
      when the post was to everyone. The author is never told, and a person who is both named
      and in everyone is told once, as named;
    - push goes to everyone a post tells: people named directly AND, for a post to everyone (the
      default), every member. The badge rises for the same people. `everyone_push` can switch
      the push off for everyone posts, leaving the badge, for a team that finds it too much;
    - the badge is the unread count over `mention` rows (`unreadBadgeSql`), so it can never
      disagree with what was sent.
*/
import { tagMentionRows } from './tags.js';
import { tableNames } from './helpers.js';

export const EVERYONE_TAG = '@everyone';

/* A post is to everyone when nobody in particular is addressed. Accepts what a column read
   returns: null, an array, or the JSON text of one. */
export function isEveryone(audience) {
  let a = audience;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return !a.trim(); }
  }
  return !Array.isArray(a) || a.length === 0;
}

/* The mention rows for a post that is to everyone: one per person the host says is in
   `everyoneIds`, via '@everyone', skipping the author and anyone already told (`alreadyNotified`:
   a set of person ids, e.g. those named directly or reached by a group). A post with an
   audience writes none, because it is not to everyone. */
export function everyoneMentionRows(postId, { audience = null, everyoneIds = [], alreadyNotified = new Set(), authorPersonId = 0 } = {}) {
  if (!isEveryone(audience)) return [];
  return tagMentionRows(postId, [{ tag: 'everyone', kind: 'group', personIds: everyoneIds }], { alreadyNotified, authorPersonId });
}

/* A setting arrives as a boolean or as text; anything not clearly off is on. */
const on = (v) => !(v === false || v === 0 || /^(false|0|off|no)$/i.test(String(v ?? '').trim()));

/* Who to push and who to badge for the mention rows just written.

   `rows` are `mention` rows ({person_id, via_tag}). `settings` is the plugin's settings
   (missing ones count as on). Returns:
     push   [{person_id, via_tag}]  people to send a push to
     badge  [person_id]             people whose badge count just went up

   Every time a person is named, and every time a post is to everyone (the default), the
   person gets a push and a badge. A person reached only by another group or a followed topic
   gets the badge and no push; sending one is the host's call, as is a person's own "push me
   for everything" preference.

   Named directly follows `mention_notifications`, to everyone follows `everyone_notifications`;
   `push_notifications` and `badge_notifications` switch the two channels, and `everyone_push`
   turns the push off for posts to everyone while keeping the badge. */
export function notificationPlan(rows = [], settings = {}) {
  const push = [];
  const badge = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r || !r.person_id || seen.has(r.person_id)) continue;
    seen.add(r.person_id);
    const direct = r.via_tag == null || r.via_tag === '';
    const everyone = r.via_tag === EVERYONE_TAG;
    const kindOn = direct ? on(settings.mention_notifications) : everyone ? on(settings.everyone_notifications) : true;
    if (!kindOn) continue;
    if (on(settings.badge_notifications)) badge.push(r.person_id);
    const aimed = direct || (everyone && on(settings.everyone_push));
    if (aimed && on(settings.push_notifications)) push.push({ person_id: r.person_id, via_tag: direct ? null : r.via_tag });
  }
  return { push, badge };
}

/* The words of a push: {title, body}. `post` needs `author_name` and `body`. The body is one
   line, cut at `max` characters with an ellipsis. */
export function notificationText(post = {}, viaTag = null, max = 140) {
  const who = String(post.author_name || '').trim() || 'Someone';
  const title = !viaTag ? `${who} mentioned you` : viaTag === EVERYONE_TAG ? `${who} posted to everyone` : `${who} posted to ${viaTag}`;
  const flat = String(post.body || '').replace(/\s+/g, ' ').trim();
  const body = flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
  return { title, body };
}

/* The badge: how many unread posts told this person, as SQL. Bind :me (person_id) and
   :last_read (their read_marker.last_read_at, or the epoch when they have none). Counts
   direct mentions, everyone posts and tag rows alike, since each is one `mention` row. */
export function unreadBadgeSql(prefix = '') {
  const t = tableNames(prefix);
  return `SELECT COUNT(*) AS unread FROM ${t.mention} m JOIN ${t.post} p ON p.id = m.post_id
 WHERE m.person_id = :me AND p.deleted_at IS NULL AND p.created_at > :last_read AND p.person_id <> :me`;
}

export default { EVERYONE_TAG, isEveryone, everyoneMentionRows, notificationPlan, notificationText, unreadBadgeSql };
