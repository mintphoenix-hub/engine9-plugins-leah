#!/usr/bin/env node
/*
  Finds the sites that are behind the newest engine9 core, and starts their update.

    node scripts/update-sites.mjs          report which sites are behind (changes nothing)
    node scripts/update-sites.mjs --run    also start each behind site's update workflow
    node scripts/update-sites.mjs --run --all   start it even where the site is already current
    node scripts/update-sites.mjs --json   print the result as JSON (for the status artifact); changes nothing

  Core publishes no releases, so "a new release" is a new commit on its main branch. Every site pins @engine9/core
  to a commit; this compares each pin with core's newest commit. The list of sites is sites.json. --run only
  triggers the site's own `engine9-updates` workflow, which installs, tests and opens a pull request. It never
  merges, deploys or touches a database: you read each pull request. A site with `workflow: null` is reported so
  you know to wire one up (copy .github/workflows/engine9-updates.yml and scripts/update-engine9.mjs from
  loving-motion). Needs the GitHub CLI signed in (`gh auth login`) with access to each repo.
*/
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CORE_REPO = 'https://github.com/engine9-ai/core.git';

/* First 40-hex sha in `git ls-remote` output. */
export const firstSha = (out) => (/\b([0-9a-f]{40})\b/.exec(String(out)) || [])[1] || null;

/* The commit a package.json pins core to: "github:engine9-ai/core#03de2f6" -> "03de2f6". Null when it is not
   pinned to a commit (a branch, a range, or absent). */
export function pinnedSha(pkg) {
  const spec = pkg?.dependencies?.['@engine9/core'] ?? pkg?.devDependencies?.['@engine9/core'] ?? '';
  return (/#([0-9a-f]{7,40})$/.exec(spec) || [])[1] || null;
}

/* Abbreviated pins are common (7 or 8 chars), so compare as a prefix. */
export const isCurrent = (pin, newest) => Boolean(pin && newest && newest.startsWith(pin));

/* What to do for one site. */
export function plan({ pin, newest, workflow, all = false }) {
  if (!pin) return { state: 'unpinned', trigger: false };
  const current = isCurrent(pin, newest);
  if (current && !all) return { state: 'current', trigger: false };
  if (!workflow) return { state: current ? 'current' : 'behind-no-workflow', trigger: false };
  return { state: current ? 'current' : 'behind', trigger: true };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const go = args.includes('--run');
  const all = args.includes('--all');
  const asJson = args.includes('--json');
  const results = [];
  const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const root = new URL('..', import.meta.url).pathname;
  const { sites } = JSON.parse(readFileSync(`${root}sites.json`, 'utf8'));

  const newest = firstSha(run('git', ['ls-remote', CORE_REPO, 'HEAD']).stdout);
  if (!newest) { console.error('Could not read the newest core commit.'); process.exit(1); }
  const log = asJson ? () => {} : console.log;
  log(`engine9 core is at ${newest.slice(0, 7)}\n`);

  let problems = 0;
  for (const s of sites) {
    const got = run('gh', ['api', `repos/${s.repo}/contents/package.json`, '-H', 'Accept: application/vnd.github.raw']);
    if (got.status !== 0) { problems++; log(`?  ${s.repo}: could not read package.json (${(got.stderr || '').trim().split('\n')[0]})`); continue; }
    let pkg; try { pkg = JSON.parse(got.stdout); } catch { problems++; log(`?  ${s.repo}: package.json is not JSON`); continue; }
    const pin = pinnedSha(pkg);
    const p = plan({ pin, newest, workflow: s.workflow, all });
    const pulls = run('gh', ['api', `repos/${s.repo}/pulls?state=open&per_page=50`, '--jq', '[.[] | select(.head.ref | startswith("engine9-update/")) | {number, url: .html_url, draft, title}] | .[0] // null']);
    const pr = pulls.status === 0 && pulls.stdout.trim() && pulls.stdout.trim() !== 'null' ? JSON.parse(pulls.stdout) : null;
    results.push({ repo: s.repo, name: s.repo.split('/')[1], pinned: pin, newest, state: pr ? 'ready' : p.state, workflow: Boolean(s.workflow), pr });
    const label = { current: 'ok     ', behind: 'BEHIND ', 'behind-no-workflow': 'BEHIND ', unpinned: '?      ' }[p.state];
    log(`${label}${s.repo}  pinned ${pin ? pin.slice(0, 7) : 'not to a commit'}${p.state === 'behind-no-workflow' ? '  (no update workflow: wire one up)' : ''}`);
    if (p.state === 'unpinned') problems++;
    if (go && p.trigger) {
      const r = run('gh', ['workflow', 'run', s.workflow, '-R', s.repo]);
      if (r.status === 0) log(`         started ${s.workflow}; a pull request follows if anything changed`);
      else { problems++; log(`         could not start ${s.workflow}: ${(r.stderr || '').trim().split('\n')[0]}`); }
    }
  }
  if (asJson) console.log(JSON.stringify({ core: newest, checkedAt: new Date().toISOString(), sites: results }, null, 2));
  if (!go && !asJson) log('\nNothing was started. Add --run to start the update on the sites marked BEHIND.');
  process.exit(problems ? 1 : 0);
}
