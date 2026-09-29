import schema from './schema.js';
import { settings } from './settings.js';
import * as mentions from './mentions.js';
import * as tags from './tags.js';
import * as helpers from './helpers.js';

const metadata = {
  name: 'Board',
  prefix: 'board',
  unique: true,
  version: '1.6.0',
  dependencies: {
    '@engine9/interfaces/person': '>=1.0.0'
  },
  schemas: ['schema.js']
};

export { metadata, schema, settings, mentions, tags, helpers };
export * from './mentions.js';
export * from './tags.js';
export * from './helpers.js';
export default {
  metadata,
  schema,
  settings,
  mentions,
  tags,
  helpers
};
