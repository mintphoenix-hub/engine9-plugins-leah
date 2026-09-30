# Site updates

Not a plugin (no `index.js`, no schema, nothing to install): a small module a site's admin uses to say "a newer engine9 core is available" and to start the update when the person confirms. Import it as `@mintphoenix/plugins/site-updates/updates.js` and `.../banner.js`, or copy the two files stamped with the release (see [AGENTS.md](../AGENTS.md)).

Nothing here merges or deploys. **Update** runs the site's own `engine9-updates` workflow, which installs, tests and opens a pull request; the person reads and merges that on GitHub. See [`scripts/update-sites.mjs`](../scripts/update-sites.mjs) for the same check from a terminal.

## Wiring it in

1. The site needs `.github/workflows/engine9-updates.yml` (copy it from `loving-motion`).
2. Create a fine-grained GitHub token for that repository only: **Actions: read and write**, **Pull requests: read**, **Contents: read**. It is a secret (`wrangler secret put GITHUB_UPDATE_TOKEN`), never in the page or the repository.
3. Mount the routes behind the site's own admin check:

```js
import { updateRoutes } from '@mintphoenix/plugins/site-updates/updates.js';

const updates = updateRoutes({
  repo: 'owner/site',
  token: env.GITHUB_UPDATE_TOKEN,
  isAdmin: async (request) => Boolean(await currentAdmin(request)),   // yours; without it every request is refused
});
// in fetch(request, env):
const hit = await updates(request); if (hit) return hit;
```

`GET /api/admin/engine9-update` returns `{ state, pinned, newest, pr, running }`. `state` is `current`, `available`, `running`, `ready` (an open `engine9-update/*` pull request), `unknown` or `error`. `POST` starts the update and needs the header `X-Engine9-Update` so another website cannot trigger it from an admin's browser. It starts nothing unless `state` is `available`, so it never starts a second run.

4. In the admin page: `mountUpdateBanner(el, { url: '/api/admin/engine9-update', readyNote: 'Merging this deploys the site.' })`. It shows nothing when the site is current.

## Rules

- The module does no I/O: the host supplies `fetch` and the token.
- "Behind" means the `@engine9/core` commit pinned in the repository's default branch is older than core's newest commit. Core publishes no releases.
- The token can start workflows, so keep it to one repository and only these permissions.

Added in 3.8.0.
