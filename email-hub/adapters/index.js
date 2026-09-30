/*
  Choose a provider by name. `config` is the host's secrets and options; nothing here reads an environment.

    createProvider('kit', { apiKey })
    createProvider('mailchimp', { apiKey, listId, fromName, replyTo })
    createProvider('memory')

  To add a service: write a provider that passes `assertProvider` (../provider.js) and register it below.
*/
import { assertProvider } from '../provider.js';
import { createMailchimpProvider } from './mailchimp.js';
import { createKitProvider } from './kit.js';
import { createMemoryProvider } from './memory.js';

export const PROVIDERS = { kit: createKitProvider, mailchimp: createMailchimpProvider, memory: createMemoryProvider };

export function createProvider(name, config = {}) {
  const make = PROVIDERS[String(name || '').toLowerCase()];
  if (!make) throw new Error(`email-hub: unknown email provider "${name}" (have: ${Object.keys(PROVIDERS).join(', ')})`);
  return assertProvider(make(config));
}
export { createMailchimpProvider, createKitProvider, createMemoryProvider };
