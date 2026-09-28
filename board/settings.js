export const settings = [
  {
    name: 'allow_edit',
    type: 'boolean',
    default: true,
    description: 'Authors may edit their own posts, replies, ideas and comments. Edited items are marked with edited_at.'
  },
  {
    name: 'moderator_delete',
    type: 'boolean',
    default: true,
    description: 'Admins may delete any post; otherwise only the author can.'
  },
  {
    name: 'mention_notifications',
    type: 'boolean',
    default: true,
    description: 'Tell people directly when a post @mentions them (a mention row is written for every mention).'
  },
  {
    name: 'reaction_emoji',
    type: 'string',
    default: '👍,❤️,😂,🎉,👀',
    description: 'Comma-separated emoji offered as post reactions.'
  }
];
export default { settings };
