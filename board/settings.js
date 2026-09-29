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
    name: 'everyone_notifications',
    type: 'boolean',
    default: true,
    description: 'Count a post to everyone (no audience, the default) as unread for everyone: a mention row via @everyone is written for each person. Each is told with a badge and, unless everyone_push is off, a push.'
  },
  {
    name: 'push_notifications',
    type: 'boolean',
    default: true,
    description: 'Send a push each time a person is named, and each time a post is to everyone (the default). The host delivers it; notificationPlan says to whom.'
  },
  {
    name: 'everyone_push',
    type: 'boolean',
    default: true,
    description: 'Push people about posts to everyone. Turn it off for a busy board to keep those to the badge only; a person named directly is still pushed.'
  },
  {
    name: 'badge_notifications',
    type: 'boolean',
    default: true,
    description: 'Raise the unread badge for people told by a post. The badge is the unread count over mention rows.'
  },
  {
    name: 'reaction_emoji',
    type: 'string',
    default: '👍,❤️,😂,🎉,👀',
    description: 'Comma-separated emoji offered as post reactions.'
  }
];
export default { settings };
