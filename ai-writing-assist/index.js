import schema from './schema.js';
import { settings } from './settings.js';
import * as prompt from './prompt.js';
import * as assist from './assist.js';
import * as helpers from './helpers.js';

const metadata = {
  name: 'AI writing assist',
  unique: true,
  dependencies: {},
  schemas: ['schema.js']
};

export { metadata, schema, settings, prompt, assist, helpers };
export * from './prompt.js';
export * from './assist.js';
export * from './helpers.js';
export default {
  metadata,
  schema,
  settings,
  prompt,
  assist,
  helpers
};
