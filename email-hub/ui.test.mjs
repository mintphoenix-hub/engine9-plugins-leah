/* The screens' form fields must all look like fields. A type that has no rule in hub.css (a web address box, before 3.21.1) draws
   with no border or background and does not look clickable. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const js = readFileSync(new URL('./ui/hub.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('./ui/hub.css', import.meta.url), 'utf8');
const styled = new Set([...css.matchAll(/\.eh input\[type=([a-z-]+)\]/g)].map((m) => m[1]));
const used = new Set([...js.matchAll(/<input[^>]*\stype="([a-z-]+)"/g)].map((m) => m[1]).filter((t) => !['checkbox', 'radio', 'hidden', 'file', 'range', 'color'].includes(t)));
used.add('url'); used.add('text');                 // a layout field can be a web address or plain text, chosen at run time
const missing = [...used].filter((t) => !styled.has(t));
assert.deepEqual(missing, [], `input types with no style in hub.css: ${missing.join(', ')}`);
console.log(`ok  every text-like input type used by the screens is styled (${[...used].sort().join(', ')})`);
