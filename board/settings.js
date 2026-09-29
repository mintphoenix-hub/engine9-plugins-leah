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
    description: 'Count a post to everyone (no audience, the default) as unread for everyone: a mention row via @everyone is written for each person. Raises the badge; a push needs an explicit @everyone.'
  },
  {
    name: 'push_notifications',
    type: 'boolean',
    default: true,
    description: 'Send a push to people a message is aimed at: named directly, or pinged with an explicit @everyone. A post that is only to everyone by default raises the badge, not a push. The host delivers it; notificationPlan says to whom.'
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
