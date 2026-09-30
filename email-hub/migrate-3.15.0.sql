-- email-hub 3.14.x -> 3.15.0: emails made from a host's layout (a show announcement) keep their field values.
--
-- On a core-managed account, reinstall the plugin and core adds the table. On any other host (plain SQLite, D1 with
-- hand-run migrations) run this once. It is additive, so it is safe before or after the code that uses it; until it runs,
-- a host with no layouts is unaffected, and layouts refuse to save.
create table if not exists "engine9_email_hub_layout" (
  "id" integer primary key autoincrement,
  "campaign_id" varchar(255) not null,
  "layout" varchar(255) not null,
  "values_json" text not null,
  "created_at" datetime not null default current_timestamp,
  "modified_at" datetime not null default current_timestamp
);
create unique index if not exists "engine9_email_hub_layout_campaign_id_uidx" on "engine9_email_hub_layout" ("campaign_id");
