-- Board 1.x -> 2.0.0: from prefixed table names to self-scoped ones.
--
-- 1.x installs deployed tables as <table_prefix><name>, e.g. board_aaa_post.
-- 2.0.0 names every table mintphoenix_board_<name> and leaves plugin.table_prefix empty.
--
-- Run ONCE per install, BEFORE deploying code that uses 2.0.0, and only when core is 1.4.0 or later.
-- Read your prefix first, then replace every `board_aaa_` below with it:
--
--   SELECT id, path, table_prefix FROM plugin WHERE path = '@mintphoenix/plugins/board';
--
-- Take a backup first (D1: `wrangler d1 export`). Rows are untouched; only the names change.
-- SQLite / D1 syntax. On MySQL use `RENAME TABLE board_aaa_post TO mintphoenix_board_post, ...`.
--
-- Index and trigger names keep the old prefix inside them. That is harmless: core matches indexes
-- by their columns, and SQLite carries a table's triggers with it when it is renamed (the
-- modified_at triggers keep firing). Drop and recreate them only if you want the names to match.
--
-- Deploy order: host code must stop building names from plugin.table_prefix (use tableNames()
-- from 2.0.0) or accept both spellings, BEFORE this runs. 1.x code that reads table_prefix breaks
-- once it is empty.

ALTER TABLE board_aaa_post        RENAME TO mintphoenix_board_post;
ALTER TABLE board_aaa_reaction    RENAME TO mintphoenix_board_reaction;
ALTER TABLE board_aaa_mention     RENAME TO mintphoenix_board_mention;
ALTER TABLE board_aaa_post_tag    RENAME TO mintphoenix_board_post_tag;
ALTER TABLE board_aaa_tag_follow  RENAME TO mintphoenix_board_tag_follow;
ALTER TABLE board_aaa_read_marker RENAME TO mintphoenix_board_read_marker;
ALTER TABLE board_aaa_idea        RENAME TO mintphoenix_board_idea;
ALTER TABLE board_aaa_idea_vote   RENAME TO mintphoenix_board_idea_vote;
ALTER TABLE board_aaa_idea_comment RENAME TO mintphoenix_board_idea_comment;

-- Tell core the tables now carry no prefix. Settings rows hang off the plugin id and are unchanged.
UPDATE plugin SET table_prefix = '' WHERE path = '@mintphoenix/plugins/board';
