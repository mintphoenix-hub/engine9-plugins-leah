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

## Adapting to the site it is in

`mountEmailHub(root, { theme: true })` makes the screens take their look from the page they are mounted in, and keep up when the page changes. It reads the page's own computed styles (the background of the nearest filled ancestor, the text color, font and size, a link's color, a button's fill and corners, a heading's face and case) and its custom properties by the common names (`--primary`, `--accent`, `--background`, `--foreground`, `--card`, `--border`, `--radius`, in a plain color or the bare `H S% L%` triple design systems use), then derives every `--eh-*` variable from them. Everything derived is checked for contrast: text on a surface is at least 4.5:1, an accent at least 3:1, and a filled button's label is black or white, whichever reads better. A dark site gets a dark hub and a light one a light hub.

It re-reads the page when the site changes its look (a `class`, `style` or `data-theme` change on `<html>` or `<body>`, the visitor's light or dark setting, web fonts finishing loading; debounced), so a site with a theme switch needs to do nothing.

```js
mountEmailHub(root, { theme: true });                                   // read everything from the page
mountEmailHub(root, { theme: {
  hints: { primary: '.btn-primary', heading: 'h1' },                    // sample these real elements, when tag styles are not enough
  vars: { '--eh-radius': '0px' },                                       // explicit values always win, key by key
} });
```

Nothing is read, observed or listened to until the screens are mounted with `theme`, and `destroy()` removes everything it attached; with no `theme` option the screens look exactly as before (the plain look, or whatever `--eh-*` variables the host set). The color and contrast helpers in `ui/theme.js` are pure and tested without a browser (`theme.test.mjs`). The *emails* are a separate thing: they are built on the server and cannot read a page, so their look is the brand's defaults plus what the person sets in Content.

## Connection to engine9 core

Core keeps its own record of every person and of whether each address may be emailed (`person` and `person_email`, the standard tables of `@engine9/interfaces/person` and `person_email`; `person_email.subscription_status` is Subscribed, Unsubscribed, Not Subscribed, Bouncing or Spam). The plugin declares the person interface it relies on (`metadata.dependencies`) and, when the host passes `people`, keeps core in step with the email service:

```js
import { createCorePeople, createEmailHub } from '@mintphoenix/plugins/email-hub';
const hub = createEmailHub({ provider, brand, store, people: createCorePeople({ db: env.DB }) });
```

- **Someone leaves** (the host's public unsubscribe page, or the Unsubscribe button on a contact): every matching `person_email` row becomes Unsubscribed, the way core's own inbound upsert does it. It only updates rows core already has; it never creates one, because the public page accepts any address and must not be a way to write junk into the people table.
- **Someone is added** on the Audience screen, with the consent tick: core gets the person and the address (`Subscribed`) if it has neither, a `Not Subscribed` address moves to Subscribed, and a missing name is filled in, never overwritten. Unsubscribed, Bouncing and Spam are **never** changed, so nobody who left is quietly put back; and when the service kept someone unsubscribed (its note says so), core is not told they consented.
- Both run **after** the service accepted the change. A failure in core never undoes or hides it: it is logged, without the address, and the hub carries on. What the service accepted is what happened.
- An address is matched the way core matches it: trimmed and lower-cased, by its text and by `email_hash_v1` (the sha256 of that). A name goes on `person`, never on the address. Everyone is a `person`.
- Not covered: the service's own bounce and complaint states are not copied to core, and the audience itself is not imported into core's people (it lives in the service). With no `people` the hub is unchanged.

## Options a host may set

Everything below is optional and defaults to the neutral behavior, so a site that sets none of it is unchanged.

- `createEmailHub({ schedule: { leadMinutes, stepMinutes } })`: the notice required before a send and the boundary it lands on. The defaults, 15 and 15, are the strictest common ground (Mailchimp only sends on the quarter hour); a host on a service without that limit (Kit) may loosen them, never under one minute. The screens read the rules from `GET /config` (`schedule`). Nothing else about the scheduling guard is configurable.
- `brand.style.font` (`'sans'` or `'serif'`): the body face of the emails, a web-safe stack (an email client loads no web fonts). It is also a choice in the look editor and is stored in the look (`engine9_email_hub_style.font`).
- `createKitProvider({ fields: { joined, source } })`: the names of the custom fields a host keeps a person's original signup date and source in. Kit stamps everyone with the day they were imported, so after moving a list those fields are the only record of when a person really joined. `GET /contacts/<id>` returns them as `joined` and `source`.
- `provider.listTemplates()` (optional; Kit and Mailchimp have it): the service's own email templates by name, read only, at `GET /templates`, advertised as `capabilities.templates`.

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

## Host settings for the screens

`mountEmailHub(root, options)` takes `emoji`, `emojiOpen`, `fontChoice`, `logoHelp` and `extras.{homeStats, homeCards, homeBanner, analyticsBanner}`, and the look takes `--eh-primary`, `--eh-on-primary`, `--eh-heading-font`, `--eh-heading-transform`, `--eh-heading-tracking`, `--eh-scale` and `--eh-numerals`. All are optional and fall back to the plain look; the headers of `ui/hub.js` and `ui/hub.css` list them. `GET /config` may carry `schedule: { leadMinutes, stepMinutes }`, which the Schedule box uses for its input step and wording.

## Version history

- **3.11.4**: A draft's review shows a note when the provider's copy is only the message text (Kit keeps the design in its template, which its API cannot return), and drafts get a "Preview the full design in Kit" button that opens that draft in Kit. No schema change.
- **3.11.1**: Fix: the logo in every email carried another site's name as its alt text (a hard-coded string in `shell.js`); it is now the host's `brand.name`, escaped, and empty when the host sets none. Test fixtures carry no host names or addresses.
- **3.11.0**: Connection to engine9 core's people (`people.js`, `createCorePeople`, `createEmailHub({ people })`): an unsubscribe on the host's page or on a contact, and a contact added with the consent tick, are also recorded in `person` / `person_email` after the service accepts them, by core's own rules (every matching address, never creating a row for an unsubscribe, never putting back Unsubscribed, Bouncing or Spam). The plugin now declares `@engine9/interfaces/person` in `metadata.dependencies`, so core installs it alongside; `core.test.mjs` therefore checks it by compile and schema, as it does the board. Additive and off by default.
- **3.10.0**: `theme: true` makes the screens adapt to the site they are in and follow it when it changes (`ui/theme.js`: reads computed styles and common custom properties, derives every `--eh-*` variable with contrast checks, watches for class, style and light/dark changes). No side effects until it is asked for, and off by default, so an existing host is unchanged.
- **3.9.0**: Options for hosts, all additive and defaulting to today's behavior: a body font (`brand.style.font`, stored as `style.font`; migrate an existing install with `migrate-3.9.0.sql`), loosenable scheduling rules (`createEmailHub({ schedule })`, told to the screens by `/config`), the service's templates listed by name (`GET /templates`, `capabilities.templates`), and the Kit adapter's `fields` option for a contact's original signup date and source.
- **3.7.1**: The Audience choices (All contacts, Tags, Segments, Fields, Import contacts) are a submenu under Audience in the left nav. One corner size (`--eh-radius`, 10px) for buttons, nav, tabs, tiles, cards, fields and tags. `core-updates` ignores any lockfile and records the core commit npm really installed; interfaces are taken from their repository like core. No table, setting or export changed.
- **3.7.0**: First release. Provider contract with Mailchimp, Kit and in-memory adapters; `createEmailHub`; the browser screens; the look of the emails with an optional postal address and logo uploads; the unsubscribe-through-your-own-website flow; the `core-updates` workflow.
