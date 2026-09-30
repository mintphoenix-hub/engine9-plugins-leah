import assert from 'node:assert/strict';
import { firstSha, bumpPatch, decide, resolvedSha } from './core-updates.mjs';

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const A = 'a'.repeat(40), B = 'b'.repeat(40);

ok('reads the commit from git ls-remote output', () => { assert.equal(firstSha(`${A}\tHEAD\n`), A); assert.equal(firstSha(''), null); assert.equal(firstSha('not a sha'), null); });
ok('a compatibility bump only moves the patch number', () => { assert.equal(bumpPatch('3.7.0'), '3.7.1'); assert.equal(bumpPatch('3.7.9'), '3.7.10'); assert.throws(() => bumpPatch('3.7'), /plain version/); assert.throws(() => bumpPatch('3.7.0-beta'), /plain version/); });
ok('does nothing while core has not moved, and tests when it has', () => {
  assert.equal(decide({ recorded: A, newest: A }).action, 'none');
  assert.equal(decide({ recorded: A, newest: B }).action, 'test');
  assert.equal(decide({ recorded: null, newest: B }).action, 'test');
  assert.equal(decide({ recorded: A, newest: null }).action, 'unknown');
});
ok('reads the commit npm actually installed from the lockfile', () => {
  const lock = { packages: { 'node_modules/@engine9/core': { resolved: `git+ssh://git@github.com/engine9-ai/core.git#${A}` }, 'node_modules/x': { resolved: 'https://registry/x.tgz' } } };
  assert.equal(resolvedSha(lock, '@engine9/core'), A); assert.equal(resolvedSha(lock, 'x'), null); assert.equal(resolvedSha(null, '@engine9/core'), null);
});
console.log(`${n} passed`);
