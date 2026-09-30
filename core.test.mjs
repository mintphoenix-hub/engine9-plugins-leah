/*
  Does this package still work with the engine9 core it will be installed against?

  Runs in CI every day against the newest @engine9/core, and on every push. For each plugin here
  it does what a real install does (AGENTS.md, "Changing the plugin", step 6):

    1. compiles the plugin through core's own registry,
    2. installs it into a scratch in-memory database with core's PluginWorker,
    3. checks the tables, the settings and the install hook's message,
    4. installs it again (a reinstall must change nothing and must not throw),
    5. passes the schema through standardizeSchema for both the SQLite and MySQL dialects.

  A failure here after a core release means core changed under us: fix the plugin, or pin core.
*/
import { readdirSync, existsSync, readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPluginRegistry, compileRegistryPlugin, composePluginRegistries, setDefaultPluginRegistry } from '@engine9/core/pluginRegistry';
import { createNodePluginRegistry } from '@engine9/core/plugins/node';
import PluginWorker from '@engine9/core/PluginWorker';
import { standardizeSchema } from '@engine9/core/sql/standardizeSchema';
import * as SQLite from '@engine9/core/sql/dialects/SQLite';
import * as MySQL from '@engine9/core/sql/dialects/MySQL';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };

const here = new URL('.', import.meta.url);
const dirs = readdirSync(here, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !['node_modules', '.git', '.github'].includes(d.name) && existsSync(new URL(`${d.name}/index.js`, here)))
  .map((d) => d.name).sort();

/* Only the plugins with no plugin dependencies can be installed alone in a scratch database. The
   others (the board needs the person interface) are checked for compile + schema only. */
const STANDALONE = new Set(['ai-writing-assist', 'email-hub']);

let core = 'unknown';
try { core = JSON.parse(readFileSync(new URL('node_modules/@engine9/core/package.json', here), 'utf8')).version; } catch { /* label only */ }
console.log(`core ${core}; plugins: ${dirs.join(', ')}\n`);

/* core installs its own base plugin (@engine9/interfaces/plugin) first, so the worker needs a registry that
   knows the published interfaces as well as ours. A scratch project lists only @engine9/interfaces. */
const scratch = mkdtempSync(path.join(tmpdir(), 'e9-compat-'));
writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ type: 'module', engine9: { pluginPackages: ['@engine9/interfaces'] } }));
symlinkSync(fileURLToPath(new URL('node_modules', here)), path.join(scratch, 'node_modules'), 'dir');
const interfaces = createNodePluginRegistry({ cwd: scratch });

for (const dir of dirs) {
  const path = `@mintphoenix/plugins/${dir}`;
  console.log(path);
  const entry = { index: () => import(new URL(`${dir}/index.js`, here)) };
  if (existsSync(new URL(`${dir}/schema.js`, here))) entry.schema = () => import(new URL(`${dir}/schema.js`, here));
  if (existsSync(new URL(`${dir}/settings.js`, here))) entry.settings = () => import(new URL(`${dir}/settings.js`, here));
  const registry = createPluginRegistry({ [path]: entry }, { packageVersions: { '@mintphoenix/plugins': 'test' } });

  let compiled;
  try { compiled = await compileRegistryPlugin(registry, path); } catch (e) { ck('compiles through core\'s registry', false, e.message); continue; }
  ck('compiles through core\'s registry', Boolean(compiled?.metadata?.name));
  ck('is a native plugin: unique, and sets no metadata.prefix', compiled.metadata.unique === true && compiled.metadata.prefix === undefined);
  ck('declares no metadata.version (the package version is the only one)', compiled.metadata.version === undefined);

  const schema = compiled.schema || (await entry.schema?.())?.default;
  const tables = schema?.tables || [];
  ck('has a schema with tables', tables.length > 0);
  for (const [label, dialect] of [['SQLite', SQLite], ['MySQL', MySQL]]) {
    try { standardizeSchema(JSON.parse(JSON.stringify({ tables })), dialect); ck(`schema is accepted by core's ${label} dialect`, true); }
    catch (e) { ck(`schema is accepted by core's ${label} dialect`, false, e.message); }
  }

  if (!STANDALONE.has(dir)) continue;
  setDefaultPluginRegistry(composePluginRegistries(interfaces, registry));
  const worker = new PluginWorker({ accountId: 'ci', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    const first = await worker.install({ path, unique: true });
    ck('installs into a scratch database', Boolean(first?.id));
    for (const t of tables) {
      const desc = await worker.describe({ table: t.name });
      const have = new Set(desc.columns.map((c) => c.name));
      ck(`table ${t.name} exists with every column`, Object.keys(t.columns).every((c) => have.has(c)));
    }
    const declared = (compiled.settings || []).map((s) => s.name);
    const stored = await worker.getSettings({ pluginId: first.id });
    ck('every declared setting has a default row', declared.every((n) => n in stored), `declared ${declared.join(', ')}`);
    if (typeof compiled.install === 'function') ck('the install hook ran and reported', (first.messages || []).length === 1, (first.messages || []).join(' | '));

    await worker.setSetting({ pluginId: first.id, name: declared[0], value: 'operator-value' });
    const second = await worker.install({ path, unique: true });
    ck('reinstalling gives the same plugin', second.id === first.id);
    ck('reinstalling keeps the operator\'s settings', (await worker.getSettings({ pluginId: first.id }))[declared[0]] === 'operator-value');
  } catch (e) {
    ck('installs and reinstalls with core\'s PluginWorker', false, e.stack?.split('\n').slice(0, 3).join(' '));
  } finally { await worker.destroyAll(); }
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
