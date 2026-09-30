# Email Hub Plugin

`@mintphoenix/plugins/email-hub`: an admin hub for the emails a site sends to its own list, on top of whichever email service the site uses. Home, Campaigns (write, preview, schedule, report), Audience (contacts, tags, segments, fields, CSV import), Analytics, and the look of every email (colors, logo, footer, logo uploads). The hub speaks one small **provider contract**; Mailchimp and Kit adapters ship with it, and an in-memory one for demos and tests.

Working on it or wiring it in, with or without an assistant? Read [AGENTS.md](../AGENTS.md) for the repository rules.

It is a **native plugin** (`metadata.unique: true`, no `metadata.prefix`) that needs `@engine9/core` 1.4.0 or later. It owns the schema, the settings, the browser screens, the rules and the pure logic. Everything that touches your users (sign-in, who is an admin, the API keys, the HTTP server) stays in your application.

## What is where

| File | Job |
| --- | --- |
| `provider.js`, `contract.js` | The contract (`HubError`, `assertProvider`, `capabilitiesOf`) and checks for the shapes a provider returns (`problemsWithCampaign` and friends). Read `provider.js`'s header first. |
| `adapters/mailchimp.js`, `adapters/kit.js`, `adapters/memory.js`, `adapters/index.js` | The providers, and `createProvider(name, config)`. |
| `routes.js` | `createEmailHub({ provider, brand, store })`: the JSON API as a `Request -> Response` handler. |
| `schedule.js` | The one action that reaches an audience: scheduling. |
| `shell.js` | The look of an email and the HTML that carries it. Browser and Worker share it, so the preview is what is saved. |
| `store.js` | `createD1Store`: the look, the logos and the archive in the plugin's tables. |
| `unsubscribe.js` | The unsubscribe-through-your-own-website flow. |
| `logos.js`, `csv.js`, `stats.js`, `time.js`, `helpers.js` | Pure helpers. |
| `ui/hub.js`, `ui/hub.css` | The browser screens (`mountEmailHub`), themed with `--eh-*` variables. |
| `schema.js`, `settings.js` | Tables and settings. |

## Wiring it in

1. Add the package as a GitHub dependency pinned to a release tag and install the plugin on the account (see the board's README for the two steps).
2. Build a provider, a brand and a store, and serve the hub behind your own admin check:

   ```js
   import { createProvider, createEmailHub, createD1Store } from '@mintphoenix/plugins/email-hub';

   const provider = createProvider('kit', { apiKey: env.KIT_API_KEY });           // or 'mailchimp', { apiKey, listId }
   const store = createD1Store({ db: env.DB, images: env.IMAGES, publicLogoBase: 'https://example.org/email-assets/', builtIn: [/* { id, name, url } */] });
   const hub = createEmailHub({ provider, store, brand: {
     name: 'Example',
     style: { logoUrl: 'https://example.org/logo.png', footerLine: 'Example, Somewhere' },   // defaults for the look
     isLogoUrl: store.isLogoUrl,                                                             // which logo addresses may be saved
     unsubscribePage: 'https://example.org/#/unsubscribe',                                   // optional, see below
   } });

   // in the host's route, after checking the caller is an admin:
   const res = await hub.handle(request, '/campaigns', 'GET');     // null when the path is not the hub's
   ```

3. Serve the logos publicly, before any sign-in: `GET /email-assets/<file>` returns `store.serveLogo(file)`. An email client cannot sign in to load a picture.
4. Mount the screens with `mountEmailHub(root, { base, ... })` from `ui/hub.js`.

### The routes

`/config`, `/overview`, `/campaigns` (+ `/:id`, `/content`, `/report`, `/checklist`, `/duplicate`, `/schedule`, `/unschedule`, `/test`), `/audience`, `/contacts` (+ `/:id`, `/tags`, `/unsubscribe`), `/tags`, `/fields`, `/import`, `/look`, `/look/logos` (POST a multipart `file` and `name`; DELETE `/look/logos/<id>`), `/archive` (+ `/:source/:id/content`). Responses are the stable contract between the hub and its screens. Logos and the archive work even when the provider is not connected (the archive outlives the account it came from).

## Rules the hub keeps whichever provider is behind it

- **Scheduling is guarded** (`schedule.js`): a draft only, confirmed by the person, at least 15 minutes ahead, rounded up to a quarter hour (services send on :00 :15 :30 :45), and only when the service says the email is ready (its checklist, where it has one). There is no "send now".
- Only a draft can change or be deleted. A sent email can never be edited, rescheduled or deleted.
- A test send goes only to the addresses given, at most three.
- Adding someone needs a consent tick and never resubscribes a person who unsubscribed.
- Rates are fractions worked out from counts, never a service's own percentage field (services disagree about the unit).
- An error shown to the person is a calm sentence: never a key, an address, or a service's response body.

## Providers

| | Mailchimp | Kit | Memory |
| --- | --- | --- | --- |
| Adapter | `createMailchimpProvider({ apiKey, listId, fromName, replyTo })` | `createKitProvider({ apiKey })` | `createMemoryProvider()` |
| A person's state | subscribed / unsubscribed / cleaned / pending | mapped from active / cancelled / bounced / inactive | as Mailchimp |
| Send checklist, test send | yes | **no** (Kit has neither) | no |
| CSV import | yes (a Mailchimp batch) | **no** (no bulk API for a key) | no |
| Own-website unsubscribe | yes | yes | yes |

Notes that matter when you rely on it:

- **Kit** was run against a live account; the adapter records what was learned (an upsert that never changes a person's state, totals only with `include_total_count`, a stopped send reported as *sent*, retried 502/503/504/429).
- **Mailchimp**'s adapter is tested against a fake network; check the first real run.
- A held person is `pending` on Mailchimp (Mailchimp emails them a confirmation) and `inactive` on Kit (Kit will not email them until they opt in themselves).
- To add a service, write a provider that passes `assertProvider`, register it in `adapters/index.js`, and add its tests. Optional calls are advertised through `capabilities` and hidden by the screens when absent.

## Unsubscribing through your own website

On most free plans the service's hosted unsubscribe page cannot be branded or redirected. Set `brand.unsubscribePage` and the hub does this instead (details in `unsubscribe.js`):

1. Every email's footer says **Unsubscribe** and links to your page with the recipient's address filled in by the service's own merge tag (`https://example.org/#/unsubscribe?e=<merge tag>`). The service's own link stays underneath as a small **Trouble unsubscribing? Use this link.**, because the service requires it in every email and its one-click header points there.
2. **Your page** reads the address with `emailFromLink(location.hash)` (it refuses a merge tag the service left as text and asks for the address instead), shows it in a box, and **does nothing until a button is pressed**. Mail scanners open every link in a message; a page that unsubscribed on load would unsubscribe people who never clicked. Put it outside any age gate or "coming soon" card.
3. The button posts `{ email, company: '' }` (`company` is a honeypot) to a **public** route you add (no sign-in, and it must not sit behind your admin gate), which returns `hub.unsubscribe(body)` as `{ status, body }`.
4. It cancels a subscribed or held person and answers `ok` for every address, so it cannot be used to look people up. A bounced or already-cancelled person is left as the service has them.

What it cannot promise: anyone who knows an address can unsubscribe it (the link has no login, which is why step 2 asks for a click); and whether the service fills a merge tag inside a link is the service's behavior, so check the first real send. A provider without `unsubscribeByEmail` answers 501 and the hub keeps using the service's link alone.

## Data model

| Table | Purpose |
| --- | --- |
| `engine9_email_hub_style` | The look of the emails the hub writes, one row per named style (`house` is the one in force): seven `#rrggbb` colors, a logo address and width, a footer line. A NULL column means the default. |
| `engine9_email_hub_logo` | Uploaded logos: name, where the bytes are (`object_key` in the host's object storage), type and size. The bytes never go in the database. |
| `engine9_email_hub_archive` | Sent emails carried over from a provider that is gone or replaced (subject, date, figures, the HTML as sent). Unique per `source` + `source_id`, so an importer can run twice. Read-only. |

Who is subscribed, what was sent and how it did stay in the email service; the hub reads them through the provider.

## Settings

`provider` (`kit` or `mailchimp`), `list_id` (Mailchimp's audience), `from_name`, `reply_to`, `unsubscribe_page_url`. API keys are the host's secrets, never settings.

## Tests

```
node email-hub/hub.test.mjs     # the hub end to end on Mailchimp, over a fake network
node email-hub/kit.test.mjs     # the Kit provider, the memory provider, unsubscribe through the site
node email-hub/store.test.mjs   # the database store, built from schema.js, plus the archive
```

`node core.test.mjs` installs the plugin into a scratch database with core's own worker.

## Versions

Unreleased: first version. Mailchimp and Kit providers, the guarded hub API, the look and logo uploads, the archive, unsubscribe through your own website.

## Two providers, one hub

Mailchimp and Kit are tested the same way. `conformance.test.mjs` runs one scenario through `createEmailHub` against Mailchimp (`fake-mailchimp.mjs`), Kit (`fake-kit.mjs`) and the in-memory reference, and checks every answer with `contract.js`. It covers the shapes (rates are fractions, never percentages), the scheduling rules, "a sent email can never change", tags, adding and unsubscribing (a person who left is never quietly put back), and that anything a service cannot do (Kit has no bulk import and no test send) is refused with a 405 and hidden by the screens. To add a service, write a provider, register it in `adapters/index.js`, and add it to `PROVIDERS` in that test: if it passes, the screens work on it.

## Following engine9 core

`core-tested.json` records the core commit this package was last tested against, and `.github/workflows/core-updates.yml` checks for a newer one every six hours. See [AGENTS.md](../AGENTS.md#keeping-up-with-core).

## Version history

- **3.7.1**: The Audience choices (All contacts, Tags, Segments, Fields, Import contacts) are a submenu under Audience in the left nav. One corner size (`--eh-radius`, 10px) for buttons, nav, tabs, tiles, cards, fields and tags. `core-updates` ignores any lockfile and records the core commit npm really installed; interfaces are taken from their repository like core. No table, setting or export changed.
- **3.7.0**: First release. Provider contract with Mailchimp, Kit and in-memory adapters; `createEmailHub`; the browser screens; the look of the emails with an optional postal address and logo uploads; the unsubscribe-through-your-own-website flow; the `core-updates` workflow.
