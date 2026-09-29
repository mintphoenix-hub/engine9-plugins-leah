# Board Plugin

`@mintphoenix/plugins/board`: a message board for any team application. Threaded posts, emoji reactions, `@mentions`, `@group` and `#topic` tags that notify, per-person unread tracking, audience targeting, posts that hang off any other record, and an ideas list with votes and feedback.

Working on it or wiring it in, with or without an assistant? Read [AGENTS.md](../AGENTS.md) for the rules.

It is a **native plugin** (`metadata.unique: true`, no `metadata.prefix`) that depends on `@engine9/interfaces/person` (`>=1.7.0`). It needs `@engine9/core` 1.4.0 or later and `@engine9/interfaces` 1.8.0 or later. The release version is the npm `package.json` version only; the plugin declares no `metadata.version`. It owns the schema, the settings, the console screens and the pure parsing logic. Everything that touches your users, your notifications and your identity stays in your application, so nothing in the plugin assumes a particular product.

## Install

1. Add the package to the site's `package.json`:

   ```json
   { "engine9": { "pluginPackages": ["@engine9/interfaces", "@mintphoenix/plugins"] } }
   ```

2. Rebuild the plugin registry and redeploy:

   ```
   npx e9core build-plugins
   ```

3. Install onto an account with MCP `plugin` `install` and `path: "@mintphoenix/plugins/board"`. Core deploys the tables, records the plugin row and inserts the [settings](#settings).

### Table names

Every table is **self-scoped** with the stem `engine9_message_board_`: `engine9_message_board_post`, `engine9_message_board_reaction` and so on. The plugin sets no `metadata.prefix`, so core leaves `plugin.table_prefix` empty and the names in the schema are the deployed names. SQL can use them directly; there is nothing to look up first. `tableNames()` returns them by short name (`tableNames().post === 'engine9_message_board_post'`). The rest of this document uses the short names (`post`, `mention`) for readability.

If you deploy to a database core does not manage (for example plain SQLite, or D1 with hand-run migrations), generate the DDL from `board/schema.js` with core's `standardizeSchema` and `buildCreateTable`, then insert the plugin row (empty `table_prefix`) and the settings yourself.

### Upgrading

**3.3.0 -> 3.4.0** adds the `push_subscription` table and changes nothing else. On a core-managed account, reinstall the plugin and core creates it. On any other host run [`migrate-3.4.0.sql`](migrate-3.4.0.sql) once; it is additive, so it is safe before or after the code that uses it.

**2.0.0 -> 3.0.0** renames the stem from `mintphoenix_board_` to `engine9_message_board_`. Run [`migrate-3.0.0.sql`](migrate-3.0.0.sql) on each install on 2.0.0 names. Deploy host code that accepts both spellings first (see below), then run it; rows are untouched.

**1.x -> 2.0.0.**

2.0.0 renames the tables (see [Versions](#versions)). Run [`migrate-2.0.0.sql`](migrate-2.0.0.sql) on each existing install before deploying 2.0.0 code: it renames the nine tables from `<table_prefix><name>` and clears `plugin.table_prefix`. Core 1.4.0 must already be in place, because core 1.3.x refuses a schema plugin that has no `metadata.prefix`.

## Data Model

| Table | Purpose |
| --- | --- |
| `post` | A post or a reply. `reply_to_id` + `is_reply` give one level of threading; `last_activity_at` on the root moves when a reply lands. `audience_person_ids` (json) is null for everyone, otherwise the addressees. `context_table` + `context_id` attach a post to any record (an order, a campaign, a project); `context_id` is a string so any key type works. `pinned` floats a post. `edited_at` marks an edit. `deleted_at` is a soft delete so replies keep their parent. `person_id` is the author; `author_name` is the display name at posting time and identifies authors who have no person record (`person_id` 0). |
| `reaction` | One row per person per emoji per post (unique `post_id, person_id, emoji`). |
| `mention` | One row per person a post tells, as a `person_id`, never the text typed. `via_tag` is null when they were named directly, otherwise the tag that reached them (`@managers`, `#launch`). `notified_at` records when they were told. One row per person per post. |
| `post_tag` | The tags on a post. `kind` is `group` (`@managers`: notifies its members) or `topic` (`#launch`: notifies followers). Unique per post and tag. |
| `tag_follow` | A person following a topic. Unique per person and tag. |
| `read_marker` | One row per person: `last_read_at`. |
| `push_subscription` | One row per device that said yes to push: `person_id`, the browser push service's `endpoint` (unique: the natural key), and the device's two public values `p256dh` and `auth`. A phone that changes hands follows its new owner. |
| `idea`, `idea_vote`, `idea_comment` | Suggestions with a rough `timeframe`, a `status` (`Open`, `Picked up`, `Parked`, `Declined`), thumbs-up votes and feedback comments. |

Authors, reactors, mentioned people, followers and readers are all engine9 `person_id`s.

## What the plugin provides, and what your application provides

| The plugin | Your application |
| --- | --- |
| Tables, indexes, settings, console screens | Signing people in and mapping them to a `person_id` |
| `mentions.js`: give people handles, find `@name`s in text, highlight them | The list of people who can be mentioned, and their display names |
| `tags.js`: find `@group`s and `#topic`s, shape the rows | What each group means (who is in `@managers`) |
| Row shapes: `mentionRows`, `tagRows`, `tagMentionRows` | Writing them, and the SQL that reads a thread |
| `push.js` + `webpush.js`: who is pushed, what it says, the device table's SQL, Web Push encryption and sending | The VAPID keys (a secret), where a tap goes, group membership, and reading and writing your database |
| | Delivery: the badge count, email, push |
| | Who may edit or delete a post |

Everything exported from `index.js` is pure: no I/O, no globals, safe to run in a browser, a Worker or Node.

```js
import {
  withHandles, parseMentions, findMentions, mentionRows, addedMentions, MENTION_PATTERN,
  mentionQuery, suggestMentions, applyMention,
  parseHashtags, parseGroupTags, findTags, tagRows, tagMentionRows, normalizeTag,
  EVERYONE_TAG, everyoneMentionRows, notificationPlan, notificationText, unreadBadgeSql, isEveryone,
  tableNames, ORDER_OLDEST_FIRST, canonicalId, uuidFor, isUuid,
  toSqlTime, fromSqlTime, parseReactionList,
} from '@mintphoenix/plugins/board';
```

### Helpers (`helpers.js`)

| Helper | What it does |
| --- | --- |
| `tableNames()` | The deployed table names, keyed by short name: `tableNames().post === 'engine9_message_board_post'`. `TABLE_STEM` is the `engine9_message_board_` stem. |
| `ORDER_OLDEST_FIRST` | `'created_at, rowid'`. Use it wherever order is shown (see [Ordering](#ordering)). |
| `canonicalId(id)` / `uuidFor(seed)` / `isUuid(v)` | Map an id a system already has onto the plugin's uuid, deterministically. A uuid is kept; anything else always gives the same uuid, so a retried write cannot double and a client holding its own id finds the row. |
| `toSqlTime(ms)` / `fromSqlTime(text)` | Epoch milliseconds to and from the plugin's datetime text (UTC, with a fractional second). Text with no zone is read as UTC. |
| `parseReactionList(value, fallback)` | The `reaction_emoji` setting (one comma-separated string) as a list. |
| `addedMentions(before, after, people)` (in `mentions.js`) | The people an edit newly names, so adding `@Ada` tells Ada and fixing a typo tells nobody. |
| `mentionQuery` / `suggestMentions` / `applyMention` (in `mentions.js`) | The `@` picker: is the caret after `@partial`, who to offer (prefix, case- and accent-insensitive, not someone already typed out, `exclude` drops the author), and the text with the chosen handle written in. The host draws the list and owns the keys. |

### Ordering

`created_at` is a SQLite datetime, whole seconds by default, so rows written together (several reactions, a post and its first reply) share a value and their order is otherwise undefined. Order anything shown to people by `ORDER_OLDEST_FIRST` (`created_at, rowid`): `rowid` is insertion order and breaks the tie. A host that wants exact order across writes can also stamp `created_at` itself with `toSqlTime`, which keeps milliseconds.

## Posting: the whole flow

A host that follows these steps gets the plugin's behaviour, whatever its stack.

1. **Validate** the body (non-empty, a sensible maximum length).
2. **Find who is named.** Build the people list once per request and let the plugin choose handles:

   ```js
   const people = withHandles([
     { id: 'u1', displayName: 'Ada Lovelace', firstName: 'Ada' },
     { id: 'u2', displayName: 'Alan Turing',  firstName: 'Alan' },
   ]);                                   // -> each gets a `handle` (Ada, Alan)
   const named = parseMentions(body, people);          // -> ['u1']
   ```

3. **Find the tags.** Groups are the ones you define; topics are free-form:

   ```js
   const groups = parseGroupTags(body, ['everyone', 'managers']);   // -> ['managers']
   const topics = parseHashtags(body);                              // -> ['launch']
   ```

4. **Work out who each tag reaches.** For a group, resolve its members with your own query. For a topic, select `person_id` from `tag_follow` where `tag` matches.
5. **Attach a reply to the top-level post**, whichever message it answered, so stored threads stay one level deep. Reject a reply aimed at a post in a different thread (`context_table` + `context_id` must match). Set the root's `last_activity_at`.
6. **Write, in one transaction:** the `post` row; a `mention` row per person named (from `mentionRows`); `post_tag` rows (from `tagRows`); and a `mention` row per person a tag reached (from `tagMentionRows`, which skips the author and anyone already named directly and writes a person reached two ways once, under the first tag that reached them).
6a. **If the post is to everyone** (no audience), add `everyoneMentionRows` for the host's people, after the rows above.
7. **Notify** the people you wrote `mention` rows for: `notificationPlan` says who gets a push and a badge, `notificationText` writes the push. The unread count needs no extra work: it is a query over `mention`.

### Reading

- **A thread:** select the posts for a `context_table` + `context_id` where `deleted_at IS NULL`, group replies under their `reply_to_id`, join `reaction` for counts and whether the viewer reacted, and `post_tag` for the tag chips.
- **Highlighting** needs no server call: `findTags` and `findMentions` give text positions, and `MENTION_PATTERN` lets a composer highlight as you type without being handed the people list. The server still decides who was actually named.
- **Filtering by topic:** keep a thread if any post in it carries the tag; a reply that says `#launch` belongs with the post it answers.
- **Unread mentions:**

  ```sql
  SELECT COUNT(*) FROM engine9_message_board_mention m JOIN engine9_message_board_post p ON p.id = m.post_id
   WHERE m.person_id = :me AND p.deleted_at IS NULL
     AND p.created_at > :last_read AND p.person_id <> :me;
  ```

- **Unread board** (optional): a thread is new when any post in it is newer than the reader's `read_marker.last_read_at` and not written by them.

## Mentions

`handleFor` chooses what someone types after the `@`: their first name, falling back to their display name with the spaces removed (or, for a person flagged `isExternal`, the first word of it), and a second person who shares a first name gets their display name instead so two people never answer to the same handle. Matching rules, all covered by `mentions.test.mjs`:

- the longest handle wins (`@MaryAnne` is never read as `@Mary`);
- a mention ends at a word boundary (`@Meg` does not fire inside `@Megan`);
- an email address is not a mention (`someone@example.com`);
- case and accents are ignored (`@jose` finds José).

A mention is **stored as a person id, never as the text someone typed**. That keeps names out of anything you might later export, and it means renaming a person cannot orphan a mention.

## Tags

- **`@group`** notifies every member of a group your application defines: `@everyone`, `@managers`, whatever suits the team. Membership should be a live query, so a new member is reached by the next tag with nothing to keep in step.
- **`#topic`** files a post under a topic. People follow a topic to be told of new posts in it; anyone can filter the board by one.

Tag names are lower-case ASCII letters, digits, `_` and `-`, starting with a letter, at most 40 characters, with accents folded (`#Café` is `#cafe`), so a tag is always safe in a URL. An HTML entity (`&#39;`), a URL fragment (`page#top`), `C#` and `room #12` are not topics; `a@staff.com` is not a group.

## Notification semantics

| Someone is told when | Recorded as |
| --- | --- |
| a post names them (`@Ada`) | `mention` row, `via_tag` null |
| a post tags a group they are in | `mention` row, `via_tag = '@managers'` |
| a post carries a topic they follow | `mention` row, `via_tag = '#launch'` |
| a post is to everyone (no audience, the default) | `mention` row, `via_tag = '@everyone'` |

- Never the author, about their own post.
- Once per post, however many ways they were reached; a direct mention is never re-credited to a tag.
- A reply may also tell the root's author and earlier repliers; the plugin does not write those rows, so add them if you want that behaviour.
- Whether a `mention` row becomes an email, and honouring an opt-out, is the host's decision. Push and badge follow [Push and badge](#push-and-badge).

### Push and badge

A person gets a **push and a badge** each time they are **named** in a message, and each time a post is **to everyone**, which is the default (no audience). The plugin decides who and what; the host sends the push and draws the badge. For a team that finds a push on every everyone post too much, `everyone_push` off keeps those to the badge and still pushes a person named directly.

- **To everyone** is the default: `audience_person_ids` null or empty (`isEveryone`). Everyone is the host's group, resolved as a live query when the post is written. `everyoneMentionRows(postId, { audience, everyoneIds, alreadyNotified, authorPersonId })` writes one `via_tag = '@everyone'` row per person, skipping the author and anyone already told, so a person who is named and in everyone is told once, as named. A post with an audience writes none.
- **Order of writing:** direct mentions, then tag rows, then everyone rows, passing the ids already written as `alreadyNotified` each time.
- **`notificationPlan(rows, settings)`** turns the rows just written into `{ push: [{person_id, via_tag}], badge: [person_id] }`. A person named directly and every person a post to everyone reaches are in both lists; nobody is planned twice, and the author is never in it. It applies `mention_notifications`, `everyone_notifications`, `push_notifications`, `badge_notifications` and `everyone_push` (missing settings count as on). A person reached only by another group or a followed topic gets the badge and no push; sending one is the host's call, as is a person's own "push me for every post" preference.
- **`notificationText(post, viaTag, max)`** gives the push `{title, body}`: `Ada mentioned you`, `Ada posted to everyone`, `Ada posted to @managers`, with the body on one line and cut at `max` (140).
- **The badge** is `unreadBadgeSql()`: a count over `mention` rows for `:me` newer than `:last_read`, not deleted, not by them. Direct, everyone and tag rows all count because each is a `mention` row; there is no second path. Recompute it after a post lands, when the person reads (move `read_marker.last_read_at`) and when a post is deleted.
- A post addressed to specific people (`audience_person_ids` set) tells only the people it names or tags; the plugin does not treat an audience list as a mention.

### Delivering the push (`push.js`, `webpush.js`)

The plugin also sends. `webpush.js` is Web Push in WebCrypto (RFC 8291 encryption, RFC 8292 VAPID), with no third-party service and no dependencies, so it runs in a Worker, Node 18+ and Deno. `push.js` is the board's part: who hears about a post and the words of the push. Your application supplies the keys and the database.

```js
import { generateVapidKeys, validSubscription, pushRecipients, buildPushes, sendPushes, subscriptionSql, canonicalId } from '@mintphoenix/plugins/board';

// once: a key pair. The public key goes in configuration (the page needs it to subscribe),
// the private key is a secret. `subject` is a mailto: the push services can reach.
const { publicKey, privateKey } = await generateVapidKeys();
const vapid = { publicKey, privateKey, subject: 'mailto:ops@example.org' };

// a person turns notifications on: check what the browser sent, then store it
const sub = validSubscription(await request.json());        // null unless it is a real push service
const q = subscriptionSql(prefix);                          // SQL strings, `?` placeholders
await db.run(q.save, [canonicalId(sub.endpoint), personId, sub.endpoint, sub.p256dh, sub.auth, userAgent]);

// a post lands: who hears, on which devices, then send
const recipients = pushRecipients({ authorPersonId, isReply, audience, everyone: everyoneIds,
  threadPersonIds, mentionedPersonIds, taggedPersonIds });
const devices = await db.all(q.forPersons(recipients.length), recipients.map((r) => r.personId));
const pushes = buildPushes(recipients, devices, { from: 'Ada', body, url: '/board', threadKey: rootId, counts });
const { sent, gone } = await sendPushes(pushes, vapid);
for (const endpoint of gone) await db.run(q.removeGone, [endpoint]);   // a device that unsubscribed
```

- **Who hears** (`pushRecipients`): a new top-level post tells its audience (none means everyone), minus the author; a reply tells the thread (the root's author and earlier repliers), not the team; a person named, or reached by an `@group` or a followed `#topic`, hears it directly **instead of** the general notice, never both; nobody outside a post's audience is told; person 0 never is.
- **What it says** (`pushMessage`): `Ada mentioned you`, `Ada replied`, `Ada posted to #launch`, `Ada posted on the board` (name the board with `boardName`), with the body on one line and cut at 140.
- **Devices** (`subscriptionSql`): the `push_subscription` table. `save` is an upsert on `endpoint`; `remove` needs the endpoint **and** the owner, so nobody can switch off someone else's notifications by knowing an endpoint; `removeGone` deletes a device the push service reported gone. `dialect` is `'sqlite'` (also D1) or `'mysql'`.
- **Sending** (`sendPushes`): one message per device, never batched; best effort, so one bad device never stops the rest. It returns `{ sent, failed, gone, people }`, only counts and endpoints, never who a device belonged to. A mention goes out at high urgency, and pushes about one thread share a tag so they replace each other on a lock screen instead of stacking.
- **Validate every endpoint** with `validSubscription`. An endpoint is a URL a signed-in person hands your server, which then POSTs to it; without the allow-list a subscribe route lets someone make your server call any address. Pass `{ hosts }` to allow another push service.
- **No key, no send**: `pushEnabled(vapid)` is false without a public key, a private key and a subject. Apple rejects a VAPID token with no subject, so `vapidAuthorization` throws without one.
- **Nothing is ever only a push.** iPhones take a web push only once the app is on the Home Screen, so the board must still show everything and the badge (`unreadBadgeSql`) must still carry the count.

## Search

None.

## Segments

None. The plugin ships no segment definitions, so it adds nothing to the `segment` table and is unaffected by the membership-policy columns (`join_min_level`, `leave_min_level`, `manager_role_id`) that interfaces 1.8.0 adds. A `@group` is the host's: resolve its members from the host's own role segments at write time.

## Metrics

None.

## Inbound Behavior

None. The plugin adds no people-pipeline transforms; rows are written by the host application.

## Outbound Behavior

None.

## Reports and UI

No reports. `ui.console.json5` adds a **Board** menu to the engine9 console: Posts (top-level threads, latest activity first; open one for its replies), New post, Ideas, Suggest an idea, and an idea page with its feedback. The console screens are a plain record view. A conversation view with reactions and live composing is the host application's to draw.

## Settings

Declared in `settings.js`, inserted per install on first install, changed later with MCP `plugin` `setSetting`.

| Name | Type | Default | Purpose |
| --- | --- | --- | --- |
| `allow_edit` | boolean | true | Authors may edit their own posts, replies, ideas and comments. |
| `moderator_delete` | boolean | true | Admins may remove any post; otherwise only the author. "Admin" is the host's decision. With core 1.4.0 roles, that is a person in the `admin` role segment (scope `admin`). |
| `mention_notifications` | boolean | true | Tell people directly when a post names them. |
| `everyone_notifications` | boolean | true | Tell everyone about a post to everyone (no audience, the default): one `mention` row via `@everyone` each, so it raises the badge and, unless `everyone_push` is off, sends a push. |
| `push_notifications` | boolean | true | Send a push each time a person is named and each time a post is to everyone. |
| `everyone_push` | boolean | true | Push people about posts to everyone. Off keeps those to the badge; a person named directly is still pushed. |
| `badge_notifications` | boolean | true | Raise the unread badge for people told by a post. |
| `reaction_emoji` | string | `👍,❤️,😂,🎉,👀` | Comma-separated emoji offered as reactions. Validate incoming reactions against it. |

## Tests

The parsing logic has no dependencies:

```
node board/mentions.test.mjs
node board/tags.test.mjs
node board/notifications.test.mjs
node board/push.test.mjs
node board/webpush.test.mjs
node board/helpers.test.mjs
```

## Versions

The version is the npm package version in `package.json` (currently 3.4.1), which covers the whole package. Nothing else records it.

- **3.4.1**: tidy and two fixes, no API or schema change. Accent folding, the `@` boundary and one-line clipping are shared in `text.js` (not exported). A push body cut by `pushMessage` no longer ends in a space before the ellipsis, matching `notificationText`. The `@` picker tests in `mentions.test.mjs` now actually run. Fixes: `findMentions` and `findTags` spans line up with the original text when folding changes its length (an accent typed as its own character, a letter that lower-cases longer); `sendPushes` honours `ttl: 0` instead of replacing it with the 24-hour default.
- **3.4.0**: push delivery. `webpush.js` (Web Push in WebCrypto: `generateVapidKeys`, `validSubscription`, `vapidAuthorization`, `encryptPayload`, `sendPush`, `pushEnabled`) and `push.js` (`pushRecipients`, `pushMessage`, `subscriptionSql`, `buildPushes`, `sendPushes`), plus a new table, `push_subscription`. Additive: a core-managed account picks the table up when the plugin is reinstalled; any other host runs `migrate-3.4.0.sql` once. No existing table changes.
- **3.3.0**: composer helpers in `mentions.js` — `mentionQuery(text, caret)`, `suggestMentions(query, people, {limit, exclude})`, `applyMention(text, caret, mention, handle)` — so every host's `@` picker suggests exactly what the server will match. No schema change.
- **3.2.0**: a post to everyone (the default) now sends a push as well as the badge, as does every direct mention; 3.1.0 pushed only for a named person or an explicit `@everyone`. New setting `everyone_push` (default on) turns the push off for everyone posts. `notificationPlan` no longer takes `everyoneTagged`. No schema change and no migration.
- **3.1.0**: push and badge notifications. A post to everyone (no audience, the default) now counts as unread for everyone, as `mention` rows via `@everyone`, and raises the badge; push goes only to people named or pinged with an explicit `@everyone`; `notifications.js` (`isEveryone`, `everyoneMentionRows`, `notificationPlan`, `notificationText`, `unreadBadgeSql`); settings `everyone_notifications`, `push_notifications`, `badge_notifications`. No schema change and no migration.
- **3.0.0** (breaking): the table stem is `engine9_message_board_` (was `mintphoenix_board_`): `engine9_message_board_post`, ... `tableNames()` and `TABLE_STEM` return the new names. Plugin path (`@mintphoenix/plugins/board`) and settings are unchanged. Existing 2.0.0 installs must run `migrate-3.0.0.sql`. A host that wants a zero-downtime rollout probes for `engine9_message_board_post` and falls back to `mintphoenix_board_post` until the migration has run.
- **2.0.0** (breaking): tables are self-scoped (`mintphoenix_board_post`, ...) and the plugin no longer sets `metadata.prefix`, per the engine9 plugin guidelines. `metadata.version` is removed. `tableNames()` returns the new names. Requires `@engine9/core` >= 1.4.0 and `@engine9/interfaces` >= 1.8.0. Existing installs must run `migrate-2.0.0.sql` first.
- **1.6.0**: `helpers.js` (`tableNames`, `ORDER_OLDEST_FIRST`, `canonicalId`, `uuidFor`, `isUuid`, `toSqlTime`, `fromSqlTime`, `parseReactionList`, `DEFAULT_REACTIONS`) and `addedMentions`: the pieces every host was writing for itself. Documented the timestamp-tie ordering rule.
- **1.5.0**: `handleFor` reads only `displayName` (falling back to `name`); any other name field is ignored. Pass the name you show for someone as `displayName`.
- **1.4.0**: `isCrew` is now `isExternal` in `handleFor` / `withHandles`: a person the host keeps as a name rather than an account (contractor, volunteer, external collaborator) is addressed by the first word of their display name. Rename the flag when upgrading; there is no alias.
- **1.3.0**: `@group` and `#topic` tags (`tags.js`, `post_tag`, `tag_follow`, `mention.via_tag`).
- **1.2.0**: `mentions.js`: handle assignment and matching.
- **1.1.0**: `post.deleted_at` (soft delete); `post.context_id` is a string.
- **1.0.0**: the schema.

Up to 1.6.0, upgrading added tables and columns only. 2.0.0 is the first release that renames tables.
