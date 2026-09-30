import schema from './schema.js';
import { settings } from './settings.js';
import * as helpers from './helpers.js';
import * as provider from './provider.js';
import * as contract from './contract.js';
import * as shell from './shell.js';
import * as schedule from './schedule.js';
import * as csv from './csv.js';
import * as stats from './stats.js';
import * as time from './time.js';
import * as logos from './logos.js';
import * as unsubscribe from './unsubscribe.js';
import * as routes from './routes.js';
import * as store from './store.js';
import * as people from './people.js';
import * as templates from './templates.js';
import * as adapters from './adapters/index.js';

const metadata = {
  name: 'Email hub',
  unique: true,
  dependencies: {
    '@engine9/interfaces/person': '>=1.7.0'
  },
  schemas: ['schema.js']
};

export { metadata, schema, settings, helpers, provider, contract, shell, schedule, csv, stats, time, logos, unsubscribe, routes, store, people, templates, adapters };
export * from './helpers.js';
export * from './provider.js';
export * from './contract.js';
export * from './templates.js';
export * from './shell.js';
export * from './schedule.js';
export * from './csv.js';
export * from './stats.js';
export * from './time.js';
export * from './logos.js';
export * from './unsubscribe.js';
export * from './routes.js';
export * from './store.js';
export * from './people.js';
export * from './adapters/index.js';
export default {
  metadata,
  schema,
  settings,
  helpers,
  provider,
  contract,
  shell,
  schedule,
  csv,
  stats,
  time,
  logos,
  unsubscribe,
  routes,
  store,
  people,
  adapters
};
