# @mintphoenix/plugins

Engine9 native plugins. Every directory with an `index.js` is one plugin; its identity is `@mintphoenix/plugins/<directory>`. List the package in `engine9.pluginPackages` and run `npx e9core build-plugins`.

- [`board`](board/README.md) — `@mintphoenix/plugins/board`: team message board with threaded posts, reactions, @mentions, unread tracking, audience targeting and an ideas list.
- [`ai-writing-assist`](ai-writing-assist/README.md) — `@mintphoenix/plugins/ai-writing-assist`: writing help on Cloudflare Workers AI. A person says what they want in their own words and gets a suggestion to accept, edit or ignore.

Contributors and AI assistants: read [AGENTS.md](AGENTS.md) first.
