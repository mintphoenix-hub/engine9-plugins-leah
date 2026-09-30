import assert from 'node:assert/strict';
import { firstSha, pinnedSha, isCurrent, plan } from './update-sites.mjs';

const full = '03de2f62fde4cd5c52710cb77f1c8062f64d9eb0';
assert.equal(firstSha(`${full}\tHEAD\n`), full);
assert.equal(firstSha(''), null);

assert.equal(pinnedSha({ dependencies: { '@engine9/core': 'github:engine9-ai/core#03de2f62' } }), '03de2f62');
assert.equal(pinnedSha({ dependencies: { '@engine9/core': `github:engine9-ai/core#${full}` } }), full);
assert.equal(pinnedSha({ devDependencies: { '@engine9/core': 'git+https://github.com/engine9-ai/core.git' } }), null);
assert.equal(pinnedSha({ dependencies: { '@engine9/core': '^1.4.0' } }), null);
assert.equal(pinnedSha({}), null);

assert.ok(isCurrent('03de2f62', full));
assert.ok(isCurrent(full, full));
assert.ok(!isCurrent('5175bcf', full));
assert.ok(!isCurrent(null, full));

const newest = full;
assert.deepEqual(plan({ pin: '5175bcf', newest, workflow: 'u.yml' }), { state: 'behind', trigger: true });
assert.deepEqual(plan({ pin: '5175bcf', newest, workflow: null }), { state: 'behind-no-workflow', trigger: false });
assert.deepEqual(plan({ pin: '03de2f62', newest, workflow: 'u.yml' }), { state: 'current', trigger: false });
assert.deepEqual(plan({ pin: '03de2f62', newest, workflow: 'u.yml', all: true }), { state: 'current', trigger: true });
assert.deepEqual(plan({ pin: null, newest, workflow: 'u.yml' }), { state: 'unpinned', trigger: false });
console.log('update-sites: passed');
