/*
  Push notifications for the board: who hears about a post, what the push says, where the devices
  are stored, and sending.

  The plugin stores posts, reactions, mentions and read markers, and owns the parts of telling
  people that every host would otherwise decide for itself and get subtly wrong. Your application
  still owns who is signed in, what a group means, and where keys and subscriptions are kept:

    pushRecipients   WHO hears about a post, and as what          (pure)
    pushMessage      the words of a push                           (pure)
    subscriptionSql  SQL for the `push_subscription` table         (strings)
    buildPushes      recipients + stored devices -> messages       (pure)
    sendPushes       deliver them (webpush.js), best effort        (network via fetch)

  Rules, all covered by push.test.mjs:
    - a new top-level post tells its audience (`audience_person_ids`; none means everyone);
    - a reply tells the thread: the root's author and everyone who replied before, not the team;
    - naming someone, or reaching them by an @group or a followed #topic, tells that person
      directly, INSTEAD of the general notice, never both;
    - the author is never told about their own post, and nobody outside a post's audience is told
      about it, whatever reached them;
    - person 0 (no record) is never a recipient;
    - a device the push service reports gone (404 or 410) is returned so the host can delete it.

  Nothing is ever ONLY a push. iPhones take a web push only once the app is on the Home Screen, so
  the board must still show everything and the badge must still carry the count
  (notifications.js: unreadBadgeSql).
*/
import { tableNames } from './helpers.js';
import { sendPush } from './webpush.js';

const uniq = (xs) => [...new Set((xs || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/* Who hears about a post, and as what: [{personId, kind}], kind one of
   'mention' | 'tag' | 'reply' | 'post'. Every argument is person ids. */
export function pushRecipients({
  authorPersonId = 0,
  isReply = false,
  broadcast = true,          // a top-level post on this board tells its audience; false tells nobody
  audience = null,           // null or empty = everyone; else the only people who may hear of it
  everyone = [],             // who "everyone" is, when there is no audience (the host defines it)
  threadPersonIds = [],      // the root's author and earlier repliers, for a reply
  mentionedPersonIds = [],   // named directly
  taggedPersonIds = []       // reached by an @group, or by following a #topic
} = {}) {
  const author = Number(authorPersonId) || 0;
  const allowed = audience && audience.length ? new Set(uniq(audience)) : null;
  const may = (id) => id !== author && (!allowed || allowed.has(id));

  const out = [];
  const told = new Set();
  const add = (ids, kind) => {
    for (const id of uniq(ids)) {
      if (told.has(id) || !may(id)) continue;
      told.add(id);
      out.push({ personId: id, kind });
    }
  };

  add(mentionedPersonIds, 'mention');
  add(taggedPersonIds, 'tag');
  if (isReply) add(threadPersonIds, 'reply');
  else if (broadcast) add(allowed ? [...allowed] : everyone, 'post');
  return out;
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/* The words of a push: {title, body}. `tag` is what reached the person ('@managers', '#launch');
   `boardName` is what to call the board in a general notice ("Ada posted on the team board"). */
export function pushMessage(kind, { from = '', body = '', tag = '', boardName = 'the board', max = 140 } = {}) {
  const who = String(from || '').trim() || 'Someone';
  const title = kind === 'mention' ? `${who} mentioned you`
    : kind === 'tag' ? `${who} posted to ${tag || 'a tag you follow'}`
      : kind === 'reply' ? `${who} replied`
        : `${who} posted on ${boardName}`;
  return { title, body: clip(body, max) };
}

/* ---- devices ---------------------------------------------------------------------------- */

/* SQL for `push_subscription`, one row per device. `endpoint` is the natural key: the URL the
   browser's push service gave that device, so re-subscribing never makes a second row, and a phone
   that changes hands follows its new owner. Placeholders are `?`. `dialect` is 'sqlite' (also D1) or
   'mysql'. `id` is the plugin's uuid: pass one to `save` (canonicalId(endpoint) is a good one);
   on a conflict the existing row keeps its own.

     save          [id, person_id, endpoint, p256dh, auth, user_agent]
     remove        [person_id, endpoint]     only your own device: nobody can switch off someone
                                             else's notifications by knowing an endpoint
     removeGone    [endpoint]                a push service answered 404 or 410
     count         [person_id]
     countDevice   [person_id, endpoint]
     forPersons(n) n person ids -> rows { person_id, endpoint, p256dh, auth } */
export function subscriptionSql(prefix = '', dialect = 'sqlite') {
  const t = tableNames(prefix).push_subscription;
  const cols = '(id, person_id, endpoint, p256dh, auth, user_agent)';
  const save = dialect === 'mysql'
    ? `INSERT INTO ${t} ${cols} VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE person_id = VALUES(person_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`
    : `INSERT INTO ${t} ${cols} VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`;
  return {
    save,
    remove: `DELETE FROM ${t} WHERE person_id = ? AND endpoint = ?`,
    removeGone: `DELETE FROM ${t} WHERE endpoint = ?`,
    count: `SELECT COUNT(*) AS n FROM ${t} WHERE person_id = ?`,
    countDevice: `SELECT COUNT(*) AS n FROM ${t} WHERE person_id = ? AND endpoint = ?`,
    forPersons: (n) => `SELECT person_id, endpoint, p256dh, auth FROM ${t} WHERE person_id IN (${Array.from({ length: Math.max(1, n) }, () => '?').join(', ')})`
  };
}

/* ---- sending ---------------------------------------------------------------------------- */

/* Recipients + the stored devices -> one push per device. `subscriptions` are rows from
   subscriptionSql().forPersons. Options:
     from       who wrote it (a display name)          body   the post's text
     tagOf      Map or object: person id -> '@managers' / '#launch' (for the 'tag' title)
     url        where a tap goes                       boardName   see pushMessage
     threadKey  the root post's id for a reply, else the post's own; pushes about one thread
                replace each other on the lock screen instead of stacking
     counts     Map or object: person id -> badge number, so the icon can show it
   Returns [{personId, kind, subscription, message, urgency}]. A mention is high urgency. */
export function buildPushes(recipients, subscriptions, { from = '', body = '', tagOf = {}, url = '/', boardName, threadKey = '', counts = {} } = {}) {
  const kindOf = new Map((recipients || []).map((r) => [Number(r.personId), r.kind]));
  const get = (m, id) => (m instanceof Map ? m.get(id) : m?.[id]);
  const out = [];
  for (const s of subscriptions || []) {
    const personId = Number(s.person_id);
    const kind = kindOf.get(personId);
    if (!kind) continue;
    const count = get(counts, personId);
    out.push({
      personId,
      kind,
      subscription: s,
      urgency: kind === 'mention' ? 'high' : 'normal',
      message: {
        ...pushMessage(kind, { from, body, tag: get(tagOf, personId), ...(boardName ? { boardName } : {}) }),
        url,
        ...(threadKey ? { tag: `board-${threadKey}` } : {}),
        ...(Number.isInteger(count) ? { count } : {})
      }
    });
  }
  return out;
}

/* Deliver what buildPushes made. Best effort: one bad device never stops the rest. Answers
   { sent, failed, gone, people }: `gone` is the endpoints to delete (subscriptionSql().removeGone);
   only counts and endpoints leave, never who they belonged to. */
export async function sendPushes(pushes, vapid, { fetchImpl, ttl } = {}) {
  let sent = 0;
  let failed = 0;
  const gone = [];
  for (const p of pushes || []) {
    try {
      const r = await sendPush(vapid, p.subscription, p.message, {
        urgency: p.urgency,
        ...(ttl ? { ttl } : {}),
        ...(fetchImpl ? { fetchImpl } : {})
      });
      if (r.ok) sent += 1; else failed += 1;
      if (r.gone) gone.push(p.subscription.endpoint);
    } catch { failed += 1; }
  }
  return { sent, failed, gone, people: new Set((pushes || []).map((p) => p.personId)).size };
}

export default { pushRecipients, pushMessage, subscriptionSql, buildPushes, sendPushes };
