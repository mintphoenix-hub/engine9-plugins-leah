/**
 * Email hub. Every table is self-scoped with the stem `engine9_email_hub_`, so the names here are the deployed
 * names. The plugin sets no metadata.prefix; core leaves plugin.table_prefix empty and SQL, transforms and
 * reports can name the tables directly.
 *
 * The plugin keeps three small things and nothing about people. Who is subscribed, what was sent and how it
 * did stay in the email provider (Kit, Mailchimp, ...); the hub reads them through a provider adapter.
 *
 *   style    the look of the emails the hub writes: one row per named style ('house' is the one in force),
 *            seven colors, a logo, a footer line. A NULL column means the default.
 *   logo     logos uploaded for that look. The bytes live in the host's object storage under `object_key`;
 *            this table is the list, so nothing has to page through a bucket.
 *   layout   the field values behind an email made from a host's layout (a show announcement), one row per email,
 *            so a draft can be edited or duplicated by changing fields, not HTML.
 *   archive  sent emails carried over from a provider that is gone or replaced (subject, date, figures and
 *            the HTML as sent), read-only, so the history outlives the account it came from.
 */
export const tables = [
  {
    name: 'engine9_email_hub_style',
    columns: {
      id: 'id',
      slug: { type: 'string', nullable: false, description: 'Which style this is. "house" is the one the composer uses.' },
      name: { type: 'string', nullable: false },
      ground: { type: 'string', description: 'Page background, #rrggbb. NULL = default.' },
      card: { type: 'string', description: 'Card background, #rrggbb' },
      border: { type: 'string', description: 'Card edge, #rrggbb' },
      accent: { type: 'string', description: 'Rule under the logo, #rrggbb' },
      text: { type: 'string', description: 'Body words, #rrggbb' },
      muted: { type: 'string', description: 'Footer words, #rrggbb' },
      link: { type: 'string', description: 'Links, #rrggbb' },
      logo_url: { type: 'string', description: 'Absolute https address of the logo image' },
      logo_width: { type: 'int', description: 'Logo width in pixels, 80 to 400' },
      footer_line: { type: 'string', description: 'A line above the address and the unsubscribe link' },
      font: { type: 'string', values: ['sans', 'serif'], description: 'The body face of the emails: sans (default) or serif. NULL = the site\'s default.' },
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [{ columns: 'id', primary: true }, { columns: ['slug'], unique: true }]
  },
  {
    name: 'engine9_email_hub_logo',
    columns: {
      id: 'id_uuid',
      name: { type: 'string', nullable: false },
      object_key: { type: 'string', nullable: false, description: 'Where the bytes live in the host\'s object storage' },
      content_type: { type: 'string', nullable: false },
      bytes: { type: 'int', nullable: false },
      created_at: 'created_at'
    },
    indexes: [{ columns: 'id', primary: true }]
  },
  {
    name: 'engine9_email_hub_layout',
    columns: {
      id: 'id',
      campaign_id: { type: 'string', nullable: false, description: 'The provider\'s id for the email these values made' },
      layout: { type: 'string', nullable: false, description: 'Which host layout (its id) the values belong to' },
      values_json: { type: 'text', nullable: false, description: 'The field values, as JSON' },
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [{ columns: 'id', primary: true }, { columns: ['campaign_id'], unique: true }]
  },
  {
    name: 'engine9_email_hub_archive',
    columns: {
      id: 'id',
      source: { type: 'string', nullable: false, description: 'Which provider this was sent from, e.g. mailchimp' },
      source_id: { type: 'string', nullable: false, description: 'The provider\'s own id for the email' },
      title: { type: 'string' },
      subject: { type: 'string' },
      preview_text: { type: 'string' },
      sent_at: { type: 'datetime' },
      audience: { type: 'string' },
      segment_text: { type: 'text' },
      emails_sent: { type: 'int' },
      unique_opens: { type: 'int' },
      clicks: { type: 'int' },
      open_rate: { type: 'double', description: 'Percent, one decimal' },
      click_rate: { type: 'double', description: 'Percent, one decimal' },
      archive_url: { type: 'string' },
      html: { type: 'text', description: 'The email as it was sent' },
      imported_at: 'created_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['source', 'source_id'], unique: true },
      { columns: ['sent_at'] }
    ]
  }
];
export default { tables };
