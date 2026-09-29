# Agent guide: `@mintphoenix/plugins`

Read this before changing the plugin or wiring it into an application. It is written for any adopter and any assistant; nothing here is specific to one site.

## What this is

A package of engine9 native plugins. Each directory with an `index.js` is one plugin and its identity is `@mintphoenix/plugins/<directory>`. Today there is one: [`board`](board/README.md), a message board (threaded posts, reactions, `@mentions`, `@group` and `#topic` tags that notify, unread tracking, an ideas list).

The plugin owns the **schema, settings, console screens and pure parsing helpers**. Your application owns everything that touches your users: sign-in, who can be mentioned, what a group means, delivery of notifications, permissions. Keep it that way. If a change would make the plugin know about one product's vocabulary, it belongs in that product.

Read [`board/README.md`](board/README.md) first. It is the contract: data model, the posting flow, notification rules, settings, version history.

## Rules

- **Tables are self-scoped.** Every table carries the stem `engine9_message_board_` in its name and the plugin sets no `metadata.prefix`, so `plugin.table_prefix` is empty and the names are final. Use `tableNames()`. Do not set `metadata.prefix` (that is the hex allocator, for multi-instance plugins only), and do not add a table without the stem.
- **Published table and column names are the standard.** Do not rename or drop them. Add tables and columns, bump the version, and say so in the README's version history. The renames so far are 2.0.0 (self-scoping, `board/migrate-2.0.0.sql`) and 3.0.0 (stem `engine9_message_board_`, `board/migrate-3.0.0.sql`); and any future breaking change needs a migration file the same way. Renaming an option in the pure helpers is a breaking change: bump the version and note it (there are no aliases).
- **People are engine9 `person_id`s.** Authors, reactors, mentioned people, followers and readers are all `person_id`. `0` means "no person record" and such an author is identified by `post.author_name`.
- **A mention is stored as an id, never as the text typed.** `mention.person_id`, not a name. That keeps names out of anything exported and stops a rename orphaning a mention.
- **Notification rows are `mention` rows.** A person named directly has `via_tag` null; a person reached by a group or a followed topic has `via_tag` set (`@managers`, `#launch`). One row per person per post. The author is never told about their own post. The unread count is a query over `mention`; do not build a second path.
- **Threads are one level deep.** Attach a reply to the top-level post whichever message it answered, and only within the same `context_table` + `context_id`. Move the root's `last_activity_at` when a reply lands.
- **Order by `created_at, rowid`** (`ORDER_OLDEST_FIRST`). Timestamps default to whole seconds, so rows written together tie; `rowid` is insertion order. Use the helpers in `helpers.js` (`tableNames`, `canonicalId`, `toSqlTime`, `fromSqlTime`, `parseReactionList`) instead of writing them again.
- **Delete softly.** Set `post.deleted_at`. A reply must not lose its parent.
- **`context_table` + `context_id` is the link to any other record.** `context_id` is a string so any key type works. Do not add a foreign key to a host table.
- **Groups are the host's.** `parseGroupTags` finds a group name; the host decides who is in it, as a live query, so nobody has to keep a list in step.
- **Only standard exports from `index.js`:** `metadata`, `schema`, `settings`, the helper functions, and the default aggregate. No I/O in the helpers. They must run unchanged in a browser, a Worker and Node.
- **Do not put host data in this repository:** no real names, addresses, tokens, production identifiers, or an application's group names, in code, tests, fixtures or docs. Use neutral examples (`Ada`, `@managers`, `#launch`).

## Wiring it in

1. List the package in the site's `engine9.pluginPackages`, run `npx e9core build-plugins`, and install `@mintphoenix/plugins/board` on the account (MCP `plugin` `install`). Core creates the self-scoped tables, records the plugin row (empty `table_prefix`) and inserts the settings.
2. Use `tableNames()` for the table names; there is no per-install prefix to read.
3. Follow the posting flow in [`board/README.md`](board/README.md#posting-the-whole-flow): parse mentions and tags with the helpers, work out who each tag reaches, write the `post`, `mention` and `post_tag` rows in one transaction, then notify.
4. **Apply schema changes before deploying code that needs them**, and make code tolerate the gap: check that a table exists before using a feature that arrived in a later version, so a deploy that runs ahead of its migration degrades instead of failing on an `INSERT`.
5. Generate DDL for a database core does not manage from `board/schema.js` with core's `standardizeSchema` and `buildCreateTable`, and insert the plugin row (empty `table_prefix`) and settings yourself. Do not hand-write DDL that can drift from the schema.
6. If you copy the helper files into your own repository (for a bundler that only sees your tree), stamp them with the plugin version and re-copy on upgrade instead of editing the copy.

## Changing the plugin

1. Change `schema.js`, `settings.js`, the helpers or `ui.console.json5`.
2. Bump `version` in `package.json` only. It is the sole place the release version lives; never add `metadata.version`. Add a line to the README's version history.
3. Update `board/README.md`: it is the contract, and code comments are not documentation.
4. Add or update tests beside the helper (`*.test.mjs`).
5. Check that core still accepts it: compile it with core's registry (`createPluginRegistry` and `compileRegistryPlugin`) and pass the schema through `standardizeSchema` for the SQLite and MySQL dialects.

## Tests

The helpers have no dependencies:

```
node board/mentions.test.mjs
node board/tags.test.mjs
node board/notifications.test.mjs
node board/helpers.test.mjs
```

Do not start HTTP servers or apply anything to a shared database unless the person asked.

## Pitfalls that have already happened

- With core 1.3.x, a native plugin that shipped a schema had to declare `metadata.prefix` or install was refused ("Disallowed plugin"). Core 1.4.0 reversed that: a schema without a prefix installs with an empty `table_prefix`. That is why this package needs core 1.4.0 or later.
- Matching mentions by substring fires inside longer names (`@Meg` inside `@Megan`) and on email addresses. Use the helpers; they have the edge cases covered.
- Counting notifications from the text of posts instead of `mention` rows makes the unread count disagree with what was sent.
- A group that is a stored list goes stale the day someone joins. Resolve it when the post is written.

## Git

Do not commit or push unless the person asks.

## License

MIT.
