import schema from './schema.js';
import { settings } from './settings.js';
import * as mentions from './mentions.js';
import * as tags from './tags.js';
import * as notifications from './notifications.js';
import * as push from './push.js';
import * as webpush from './webpush.js';
import * as helpers from './helpers.js';

const metadata = {
  name: 'Board',
  unique: true,
  dependencies: {
    '@engine9/interfaces/person': '>=1.7.0'
  },
  schemas: ['schema.js']
};

export { metadata, schema, settings, mentions, tags, notifications, push, webpush, helpers };
export * from './mentions.js';
export * from './tags.js';
export * from './notifications.js';
export * from './push.js';
export * from './webpush.js';
export * from './helpers.js';
export default {
  metadata,
  schema,
  settings,
  mentions,
  tags,
  notifications,
  push,
  webpush,
  helpers
};
