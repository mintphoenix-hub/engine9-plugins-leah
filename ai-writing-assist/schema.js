/**
 * AI writing assist. One table, self-scoped with the stem `engine9_ai_writing_assist_`, so the name
 * here is the deployed name. The plugin sets no metadata.prefix; core leaves plugin.table_prefix
 * empty and SQL, transforms and reports can name the table directly.
 *
 * One row per request, and nothing about what was written. No text, no instructions, no names:
 * only when, which mode, how long, and how it went. That is enough to keep to a daily limit and to
 * show how much the helper is being used.
 */
export const tables = [
  {
    name: 'engine9_ai_writing_assist_use',
    columns: {
      id: 'id',
      day: { type: 'string', nullable: false, description: 'UTC calendar day, YYYY-MM-DD. The free Workers AI allowance resets at 00:00 UTC.' },
      mode: { type: 'string', values: ['rewrite', 'draft'] },
      model: { type: 'string', description: 'The model that answered, as configured when the request was made' },
      input_chars: { type: 'int', description: 'Length of the text sent, in characters (the text itself is never stored)' },
      output_chars: { type: 'int', description: 'Length of the suggestion returned, in characters' },
      outcome: { type: 'string', nullable: false, values: ['ok', 'limit', 'error', 'empty'], description: 'ok: a suggestion was returned. limit: the daily limit or the provider allowance was reached. error: the provider failed. empty: it answered with nothing usable.' },
      created_at: 'created_at'
    },
    indexes: [{ columns: 'id', primary: true }, { columns: ['day'] }]
  }
];
export default { tables };
