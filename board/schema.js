/**
 * Team message board. Every table is self-scoped with the stem `engine9_message_board_`, so the names
 * here are the deployed names. The plugin sets no metadata.prefix; core leaves plugin.table_prefix
 * empty and SQL, transforms and reports can name the tables directly.
 *
 * A post is a row in `engine9_message_board_post`. A reply is a post with reply_to_id set
 * (one level of threading): the root post shows its replies
 * underneath, and a new reply brings its thread back to the top via
 * post.last_activity_at on the root.
 *
 * Audience: audience_person_ids is null/empty for "everyone"; otherwise a JSON
 * array of person ids the post is addressed to.
 *
 * Context: a post can hang off any other record (an order, a campaign, a
 * project) via context_table + context_id, so a thread can live on that record's
 * page and, if the host wants, also appear on a main board tagged with it.
 *
 * Unread: read_marker keeps one last_read_at per person; a thread is new when any
 * post in it is newer than that and not by the reader.
 */
export const tables = [
  {
    name: 'engine9_message_board_post',
    columns: {
      id: 'id_uuid',
      person_id: { type: 'person_id', description: 'Author' },
      author_name: { type: 'string', description: 'Author display name at time of posting' },
      body: { type: 'text', nullable: false },
      reply_to_id: { type: 'foreign_uuid', description: 'Parent post; null for a top-level post' },
      is_reply: { type: 'boolean', nullable: false, default_value: false },
      audience_person_ids: { type: 'json', description: 'null = everyone, otherwise array of person ids' },
      context_table: { type: 'string', description: 'Optional table this post is about, e.g. project' },
      context_id: { type: 'string', description: 'Key of the optional record this post is about (any key type)' },
      pinned: { type: 'boolean', nullable: false, default_value: false },
      edited_at: { type: 'datetime', description: 'Set when the author edits after posting' },
      deleted_at: { type: 'datetime', description: 'Soft delete: a reply must not lose its parent, so removed posts are hidden, not dropped' },
      last_activity_at: { type: 'datetime', description: 'On a root post: newest post in its thread' },
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['person_id'] },
      { columns: ['reply_to_id'] },
      { columns: ['is_reply', 'last_activity_at'] },
      { columns: ['context_table', 'context_id'] },
      { columns: ['created_at'] }
    ]
  },
  {
    name: 'engine9_message_board_reaction',
    columns: {
      id: 'id_uuid',
      post_id: 'foreign_uuid',
      person_id: 'person_id',
      emoji: { type: 'string', nullable: false },
      created_at: 'created_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['post_id'] },
      { columns: 'post_id,person_id,emoji', unique: true }
    ]
  },
  {
    name: 'engine9_message_board_mention',
    columns: {
      id: 'id_uuid',
      post_id: 'foreign_uuid',
      person_id: { type: 'person_id', description: 'The person who was told: @mentioned, in a tagged group, or following a tagged topic' },
      via_tag: { type: 'string', description: 'Null when named directly; otherwise the tag that reached them, e.g. @managers or #launch' },
      notified_at: { type: 'datetime', description: 'When they were told directly' },
      created_at: 'created_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['person_id'] },
      { columns: 'post_id,person_id', unique: true }
    ]
  },
  {
    name: 'engine9_message_board_post_tag',
    columns: {
      id: 'id_uuid',
      post_id: 'foreign_uuid',
      tag: { type: 'string', nullable: false, description: 'Lower-case name without the @ or #' },
      kind: { type: 'string', nullable: false, default_value: 'topic', values: ['group', 'topic'], description: 'group = @managers (notifies its members); topic = #launch (notifies followers)' },
      created_at: 'created_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['tag'] },
      { columns: 'post_id,tag', unique: true }
    ]
  },
  {
    name: 'engine9_message_board_tag_follow',
    columns: {
      id: 'id_uuid',
      person_id: 'person_id',
      tag: { type: 'string', nullable: false },
      created_at: 'created_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['tag'] },
      { columns: 'person_id,tag', unique: true }
    ]
  },
  {
    name: 'engine9_message_board_read_marker',
    columns: {
      id: 'id_uuid',
      person_id: 'person_id',
      last_read_at: { type: 'datetime', nullable: false },
      modified_at: 'modified_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: 'person_id', unique: true }
    ]
  },
  {
    name: 'engine9_message_board_push_subscription',
    columns: {
      id: 'id_uuid',
      person_id: { type: 'person_id', description: 'Whose device this is' },
      endpoint: { type: 'string', length: 512, nullable: false, description: 'The URL the browser push service gave this device; the natural key' },
      p256dh: { type: 'string', length: 128, nullable: false, description: 'The device public key (base64url, 65 bytes)' },
      auth: { type: 'string', length: 64, nullable: false, description: 'The device auth secret (base64url, 16 bytes)' },
      user_agent: { type: 'string', description: 'Browser that subscribed, for telling devices apart' },
      created_at: 'created_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: 'endpoint', unique: true },
      { columns: ['person_id'] }
    ]
  },
  {
    name: 'engine9_message_board_idea',
    columns: {
      id: 'id_uuid',
      person_id: { type: 'person_id', description: 'Who suggested it' },
      author_name: 'string',
      title: { type: 'string', nullable: false },
      timeframe: { type: 'string', description: 'Rough timing, e.g. late spring, around Halloween' },
      body: { type: 'text', description: 'The details' },
      status: {
        type: 'string',
        nullable: false,
        default_value: 'Open',
        values: ['Open', 'Picked up', 'Parked', 'Declined']
      },
      edited_at: 'datetime',
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['person_id'] },
      { columns: ['status'] },
      { columns: ['created_at'] }
    ]
  },
  {
    name: 'engine9_message_board_idea_vote',
    columns: {
      id: 'id_uuid',
      idea_id: 'foreign_uuid',
      person_id: 'person_id',
      created_at: 'created_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: 'idea_id,person_id', unique: true }
    ]
  },
  {
    name: 'engine9_message_board_idea_comment',
    columns: {
      id: 'id_uuid',
      idea_id: 'foreign_uuid',
      person_id: 'person_id',
      author_name: 'string',
      body: { type: 'text', nullable: false },
      edited_at: 'datetime',
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['idea_id'] },
      { columns: ['person_id'] }
    ]
  }
];

export default {
  tables
};
