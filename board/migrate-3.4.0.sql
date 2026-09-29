-- Board 3.3.0 -> 3.4.0: adds the `push_subscription` table (one row per device that said yes to push).
--
-- Only for an install that is NOT managed by engine9 core. On a core-managed account, reinstall the
-- plugin (MCP `plugin` `install`): core diffs the schema and creates the table for you.
--
-- Additive: no existing table or row is touched, so it is safe before or after the code that uses it
-- (without it, saving a subscription answers an error and nothing is sent). Run it once; it is also
-- safe to run twice. SQLite / D1 syntax below; the columns are the same on MySQL with
-- `char(36)`, `bigint`, `varchar(512)`, `datetime`, a unique index on `endpoint` and an index on
-- `person_id`. Apply on D1 with `wrangler d1 execute --file`, not `migrations apply`.
--
-- `endpoint` is the URL the browser's push service gave that device, so it is the natural key:
-- re-subscribing never makes a second row, and a phone that changes hands follows its new owner.
-- No names or addresses are stored: an endpoint and two public values that are useless without the
-- host's VAPID private key.

create table if not exists "engine9_message_board_push_subscription" (
  "id" char(36) not null,
  "person_id" bigint not null default 0,
  "endpoint" varchar(512) not null,
  "p256dh" varchar(128) not null,
  "auth" varchar(64) not null,
  "user_agent" varchar(255),
  "created_at" datetime not null default CURRENT_TIMESTAMP,
  primary key ("id")
);
create unique index if not exists "engine9_message_board_push_subscription_endpoint_uidx" on "engine9_message_board_push_subscription" ("endpoint");
create index if not exists "engine9_message_board_push_subscription_person_id_idx" on "engine9_message_board_push_subscription" ("person_id");
