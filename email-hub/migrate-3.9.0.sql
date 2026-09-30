-- email-hub 3.8.0 -> 3.9.0: the email look gains a body font (sans or serif).
--
-- On a core-managed account, reinstall the plugin and core adds the column. On any other host (plain SQLite, D1 with
-- hand-run migrations) run this once. It is additive, so it is safe before or after the code that uses it; until it runs,
-- a host that never sets a font is unaffected and the look editor cannot save one.
ALTER TABLE engine9_email_hub_style ADD COLUMN font varchar(255);
