# Board Plugin

`@mintphoenix/plugins/board`: a team message board. Threaded posts, emoji reactions, `@mentions`, per-person unread tracking, audience targeting, posts that hang off any other record, and an ideas list with votes and feedback. Built for any team app: nothing in it is specific to one host.

A native plugin (`metadata.unique: true`, `metadata.prefix: 'board'`). Depends on `@engine9/interfaces/person`. On install core allocates the table prefix `board_<n>_` (for example `board_aaa_`), so the table names below are base names and the deployed names are `board_<n>_post` and so on. The prefix is stored on the `plugin` row's `table_prefix`; code that queries the tables reads it from there.

## Data Model

| Table | Purpose |
| --- | --- |
| `post` | A post or a reply. `reply_to_id` + `is_reply` make one level of threading; `last_activity_at` on the root moves when a reply lands. `audience_person_ids` (json) is null for everyone, otherwise the addressees. `context_table` + `context_id` attach a post to any record (an event, a prop, a show); `context_id` is a string so any key type works. `edited_at` marks an edit. `deleted_at` is a soft delete so replies keep their parent. `person_id` is the author; `author_name` is the display name at posting time and identifies authors who have no person record (`person_id` 0). |
| `reaction` | One row per person per emoji per post (unique `post_id, person_id, emoji`). |
| `mention` | One row per person a post tells, as a `person_id`, never the text typed. `via_tag` is null when they were named directly, otherwise the tag that reached them (`@writers`, `#props`). `notified_at` records when they were told. One row per person per post. |
| `post_tag` | The tags on a post: `kind` is `group` (`@writers`, notifies its members) or `topic` (`#props`, notifies followers). Unique per post and tag. |
| `tag_follow` | A person following a topic: they are told of new posts carrying it. Unique per person and tag. |
| `read_marker` | One row per person: `last_read_at`. A thread is new when any post in it is newer and not by the reader. |
| `idea`, `idea_vote`, `idea_comment` | Pitches for future events with a rough `timeframe`, a `status`, thumbs-up votes and feedback comments. |

Authors, reactors, mentioned people and readers are engine9 `person_id`s.

## Inbound Behavior

None. The plugin adds no people-pipeline transforms; rows are written by the host application.

## Outbound Behavior

None.

## Search

None.

## Segments

None.

## Metrics

None.

## Reports and UI

No reports. `ui.console.json5` adds a **Board** menu: Posts (top-level threads, latest activity first, open one for its replies), New post, Ideas, Suggest an idea, and an idea page with its feedback.

## Settings

| Name | Type | Default | Purpose |
| --- | --- | --- | --- |
| `allow_edit` | boolean | true | Authors may edit their own posts, ideas and comments. |
| `moderator_delete` | boolean | true | Admins may remove any post; otherwise only the author. |
| `mention_notifications` | boolean | true | Tell people directly when a post names them. |
| `reaction_emoji` | string | `👍,❤️,😂,🎉,👀` | Comma-separated emoji offered as reactions. |

## Behaviour the host implements

`tags.js` does the same for tags: `parseHashtags`, `parseGroupTags`, `findTags`, `tagRows`, `tagMentionRows`. Group definitions (who is in `@writers`) belong to the host; the plugin only finds the tags and shapes the rows. On post: write `post_tag` rows; work out who each group and each topic's followers are; write `mention` rows for them with `via_tag`, skipping the author and anyone already named directly.

`mentions.js` handles the matching — handles, collisions, and the edge cases (an email address is not a mention; a shorter handle never eats a longer one). Unread badges, thread ordering, permission checks and notification delivery stay application behaviour, not schema. On post: set `is_reply`; write a `mention` row per person named; on a reply, attach it to the top-level ancestor and update the root's `last_activity_at`. Notify mentioned people directly; on a reply, the root's author and earlier repliers.
