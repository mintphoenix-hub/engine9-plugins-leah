-- Board 2.0.0 -> 3.0.0: the table stem changes from mintphoenix_board_ to engine9_message_board_.
--
-- Run ONCE per install that is on 2.0.0 names (mintphoenix_board_*). An install still on the 1.x
-- prefixed names (board_<n>_*) runs migrate-2.0.0.sql first. Rows are untouched; only names change.
--
-- Take a backup first (D1: `wrangler d1 export`). SQLite / D1 syntax. On MySQL use
-- `RENAME TABLE mintphoenix_board_post TO engine9_message_board_post, ...`.
--
-- Index and trigger names keep the old prefix inside them. That is harmless: core matches indexes
-- by their columns, and SQLite carries a table's triggers with it when it is renamed.
--
-- Deploy order: host code must accept BOTH spellings (probe which table exists) before this runs,
-- or the window between deploy and migration fails. The plugin row's table_prefix stays empty.

ALTER TABLE mintphoenix_board_post         RENAME TO engine9_message_board_post;
ALTER TABLE mintphoenix_board_reaction     RENAME TO engine9_message_board_reaction;
ALTER TABLE mintphoenix_board_mention      RENAME TO engine9_message_board_mention;
ALTER TABLE mintphoenix_board_post_tag     RENAME TO engine9_message_board_post_tag;
ALTER TABLE mintphoenix_board_tag_follow   RENAME TO engine9_message_board_tag_follow;
ALTER TABLE mintphoenix_board_read_marker  RENAME TO engine9_message_board_read_marker;
ALTER TABLE mintphoenix_board_idea         RENAME TO engine9_message_board_idea;
ALTER TABLE mintphoenix_board_idea_vote    RENAME TO engine9_message_board_idea_vote;
ALTER TABLE mintphoenix_board_idea_comment RENAME TO engine9_message_board_idea_comment;
