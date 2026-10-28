// Mailchimp-first hosts: layouts run on the Mailchimp provider, and the screens' host options exist.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMailchimpProvider } from './adapters/mailchimp.js';
import { checkEmailHtml } from './pasted.js';

const ok = (m) => console.log(`  ok  ${m}`);
const mc = createMailchimpProvider({ apiKey: `${'a'.repeat(32)}-us21`, listId: 'abc' });
assert.equal(mc.capabilities.layouts, true);
assert.equal(mc.capabilities.templateChange, false);
ok('layouts are on for Mailchimp; changing a written email\'s template is not');

const hub = readFileSync(new URL('./ui/hub.js', import.meta.url), 'utf8');
for (const opt of ['hideServiceLinks', 'defaultLayout', 'plainSaveLabel']) assert.ok(hub.includes(opt), opt);
assert.ok(!hub.includes('suburb'));
ok('the screens take hideServiceLinks, defaultLayout and plainSaveLabel, and the address hint is not Australian');

const us = checkEmailHtml('<p>Hello there</p><a href="*|UNSUB|*">u</a> WETA, 3620 27th St S, Arlington, VA 22206', { unsubscribe: '*|UNSUB|*', address: '*|LIST:ADDRESSLINE|*' });
assert.equal(us.warnings.filter((w) => /postal address/.test(w)).length, 0);
ok('a US postal address with a state and ZIP counts as an address');
console.log('3 passed');
