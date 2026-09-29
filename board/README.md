# Board Plugin

`@mintphoenix/plugins/board`: a message board for any team application. Threaded posts, emoji reactions, `@mentions`, `@group` and `#topic` tags that notify, per-person unread tracking, audience targeting, posts that hang off any other record, and an ideas list with votes and feedback.

Working on it or wiring it in, with or without an assistant? Read [AGENTS.md](../AGENTS.md) for the rules.

It is a **native plugin** (`metadata.unique: true`, `metadata.prefix: 'board'`) that depends on `@engine9/interfaces/person`. It owns the schema, the settings, the console screens and the pure parsing logic. Everything that touches your users, your notifications and your identity stays in your application, so nothing in the plugin assumes a particular product.

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

### Table names and the prefix

Core gives a native plugin a per-install table prefix, `board_<n>_`, where `<n>` is a counter in hex (for example `board_aaa_`). The names in this document are **base names**; the deployed names are `board_aaa_post`, `board_aaa_reaction` and so on. The prefix is stored on the plugin row, so read it from there rather than hard-coding it:

```sql
SELECT table_prefix FROM plugin WHERE path = '@mintphoenix/plugins/board';
```

If you deploy to a database core does not manage (for example plain SQLite, or D1 with hand-run migrations), generate the DDL from `board/schema.js` with core's `standardizeSchema` and `buildCreateTable`, using the prefix core would allocate, then insert the plugin row and the settings yourself.

## Data Model

| Table | Purpose |
| --- | --- |
| `post` | A post or a reply. `reply_to_id` + `is_reply` give one level of threading; `last_activity_at` on the root moves when a reply lands. `audience_person_ids` (json) is null for everyone, otherwise the addressees. `context_table` + `context_id` attach a post to any record (an order, a campaign, a project); `context_id` is a string so any key type works. `pinned` floats a post. `edited_at` marks an edit. `deleted_at` is a soft delete so replies keep their parent. `person_id` is the author; `author_name` is the display name at posting time and identifies authors who have no person record (`person_id` 0). |
| `reaction` | One row per person per emoji per post (unique `post_id, person_id, emoji`). |
| `mention` | One row per person a post tells, as a `person_id`, never the text typed. `via_tag` is null when they were named directly, otherwise the tag that reached them (`@managers`, `#launch`). `notified_at` records when they were told. One row per person per post. |
| `post_tag` | The tags on a post. `kind` is `group` (`@managers`: notifies its members) or `topic` (`#launch`: notifies followers). Unique per post and tag. |
| `tag_follow` | A person following a topic. Unique per person and tag. |
| `read_marker` | One row per person: `last_read_at`. |
| `idea`, `idea_vote`, `idea_comment` | Suggestions with a rough `timeframe`, a `status` (`Open`, `Picked up`, `Parked`, `Declined`), thumbs-up votes and feedback comments. |

Authors, reactors, mentioned people, followers and readers are all engine9 `person_id`s.

## What the plugin provides, and what your application provides

| The plugin | Your application |
| --- | --- |
| Tables, indexes, settings, console screens | Signing people in and mapping them to a `person_id` |
| `mentions.js`: give people handles, find `@name`s in text, highlight them | The list of people who can be mentioned, and their display names |
| `tags.js`: find `@group`s and `#topic`s, shape the rows | What each group means (who is in `@managers`) |
| Row shapes: `mentionRows`, `tagRows`, `tagMentionRows` | Writing them, and the SQL that reads a thread |
| | Delivery: the badge count, email, push |
| | Who may edit or delete a post |

Everything exported from `index.js` is pure: no I/O, no globals, safe to run in a browser, a Worker or Node.

```js
import {
  withHandles, parseMentions, findMentions, mentionRows, addedMentions,
  parseHashtags, parseGroupTags, findTags, tagRows, tagMentionRows, normalizeTag,
  tableNames, ORDER_OLDEST_FIRST, canonicalId, uuidFor, isUuid,
  toSqlTime, fromSqlTime, parseReactionList,
} from '@mintphoenix/plugins/board';
```

### Helpers (`helpers.js`)

| Helper | What it does |
| --- | --- |
| `tableNames(prefix)` | The deployed table names for an install: `tableNames('board_aaa_').post === 'board_aaa_post'`. Pass the `table_prefix` from the plugin row. |
| `ORDER_OLDEST_FIRST` | `'created_at, rowid'`. Use it wherever order is shown (see [Ordering](#ordering)). |
| `canonicalId(id)` / `uuidFor(seed)` / `isUuid(v)` | Map an id a system already has onto the plugin's uuid, deterministically. A uuid is kept; anything else always gives the same uuid, so a retried write cannot double and a client holding its own id finds the row. |
| `toSqlTime(ms)` / `fromSqlTime(text)` | Epoch milliseconds to and from the plugin's datetime text (UTC, with a fractional second). Text with no zone is read as UTC. |
| `parseReactionList(value, fallback)` | The `reaction_emoji` setting (one comma-separated string) as a list. |
| `addedMentions(before, after, people)` (in `mentions.js`) | The people an edit newly names, so adding `@Ada` tells Ada and fixing a typo tells nobody. |

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
7. **Notify** the people you wrote `mention` rows for. The unread count needs no extra work: it is a query over `mention`.

### Reading

- **A thread:** select the posts for a `context_table` + `context_id` where `deleted_at IS NULL`, group replies under their `reply_to_id`, join `reaction` for counts and whether the viewer reacted, and `post_tag` for the tag chips.
- **Highlighting** needs no server call: `findTags` and `findMentions` give text positions, and `MENTION_PATTERN` lets a composer highlight as you type without being handed the people list. The server still decides who was actually named.
- **Filtering by topic:** keep a thread if any post in it carries the tag; a reply that says `#launch` belongs with the post it answers.
- **Unread mentions:**

  ```sql
  SELECT COUNT(*) FROM <prefix>mention m JOIN <prefix>post p ON p.id = m.post_id
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

- Never the author, about their own post.
- Once per post, however many ways they were reached; a direct mention is never re-credited to a tag.
- A reply may also tell the root's author and earlier repliers; the plugin does not write those rows, so add them if you want that behaviour.
- Whether a `mention` row becomes an email or a push, and honouring an opt-out, is the host's decision.

## Search

None.

## Segments

None.

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
| `allow_edit` | boolean | true | Authors may edit their own posts, ideas and comments. |
| `moderator_delete` | boolean | true | Admins may remove any post; otherwise only the author. |
| `mention_notifications` | boolean | true | Tell people directly when a post names them. |
| `reaction_emoji` | string | `👍,❤️,😂,🎉,👀` | Comma-separated emoji offered as reactions. Validate incoming reactions against it. |

## Tests

The parsing logic has no dependencies:

```
node board/mentions.test.mjs
node board/tags.test.mjs
```

## Versions

- **1.6.0**: `helpers.js` (`tableNames`, `ORDER_OLDEST_FIRST`, `canonicalId`, `uuidFor`, `isUuid`, `toSqlTime`, `fromSqlTime`, `parseReactionList`, `DEFAULT_REACTIONS`) and `addedMentions`: the pieces every host was writing for itself. Documented the timestamp-tie ordering rule.
- **1.5.0**: `handleFor` reads only `displayName` (falling back to `name`); any other name field is ignored. Pass the name you show for someone as `displayName`.
- **1.4.0**: `isCrew` is now `isExternal` in `handleFor` / `withHandles`: a person the host keeps as a name rather than an account (contractor, volunteer, external collaborator) is addressed by the first word of their display name. Rename the flag when upgrading; there is no alias.
- **1.3.0**: `@group` and `#topic` tags (`tags.js`, `post_tag`, `tag_follow`, `mention.via_tag`).
- **1.2.0**: `mentions.js`: handle assignment and matching.
- **1.1.0**: `post.deleted_at` (soft delete); `post.context_id` is a string.
- **1.0.0**: the schema.

Upgrading adds tables and columns only; nothing is renamed or removed.
