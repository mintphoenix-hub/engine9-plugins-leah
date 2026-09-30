/*
  Unsubscribing through the HOST's own website instead of the email service's hosted page.

  Why: on most free plans the service's unsubscribe page cannot be branded or redirected, so a person who clicks
  "Unsubscribe" lands somewhere that looks nothing like the sender. The fix is a page on the host's site, styled by the
  host, that unsubscribes through the service's API. The plugin owns the parts that must be right and must not drift
  between hosts; the host owns the page and the route.

  The flow
    1. Every email the hub writes links "Unsubscribe" to the host's page, with the recipient's address filled in by the
       service's own merge tag:   https://example.org/#/unsubscribe?e=<merge tag for the address>
       (`unsubscribeLink`, from `brand.unsubscribePage` and the provider's `mergeTags.email`). The service's own link
       stays underneath as "Trouble unsubscribing? Use this link.", because the service requires it in every email and
       its one-click header (Gmail's Unsubscribe button) points there. It is a fallback, not a second way to leave.
    2. The page reads the address from the link (`emailFromLink`), shows it in a box the person can correct, and DOES
       NOTHING until they press a button. Mail scanners open every link in a message; a page that unsubscribed on load
       would quietly unsubscribe people who never clicked.
    3. The button posts `{ email, company: '' }` to a PUBLIC route on the host, which calls `hub.unsubscribe(body)`
       (`handleUnsubscribe`) and sends back the { status, body } it returns. `company` is a honeypot: a real person
       never fills it in.
    4. It cancels a subscribed or held person and always answers ok, so the page reads the same for an address that was
       on the list and one that was not: it cannot be used to find out who is subscribed.

  What it cannot promise
    - Anyone who knows an address can unsubscribe it: the link has no login. That is the price of a one-click leave, and
      why step 2 asks for a click. (A signed link would need the address signed per recipient, which only the service can
      do at send time.)
    - Whether the service fills the merge tag inside a link is the service's behavior. When it does not, the link carries
      the literal tag text; `emailFromLink` refuses it and the page asks for the address instead. Check the first real send.
    - The route must be reachable without a sign-in, and the page must sit outside any age gate or "coming soon" card, or
      leaving becomes harder than joining.
    - The provider must offer `unsubscribeByEmail` (Kit and Mailchimp do). Without it the route answers 501 and the hub
      keeps using the service's own link alone.
*/

const EMAIL = /^[^\s@<>(),;:"{}|*]+@[^\s@<>(),;:"{}|*]+\.[^\s@<>(),;:"{}|*]+$/;

/* The link to put in an email, or null when the host has no page of its own (or the provider cannot unsubscribe by
   address). `pageUrl` may already carry a query or a hash query. */
export function unsubscribeLink(pageUrl, provider) {
  const base = String(pageUrl || '').trim();
  if (!base || typeof provider?.unsubscribeByEmail !== 'function') return null;
  const tag = provider.mergeTags?.email;
  if (!tag) return base;
  return `${base}${base.includes('?') ? '&' : '?'}e=${tag}`;
}

/* The address out of the page's query string ("e=..." or "?e=..." or a whole hash), or '' when there is none or when
   it is a merge tag the service did not fill (braces, pipes and asterisks are refused). A "+" arrives as a space once
   the query is decoded, so spaces go back to "+" (an address never contains a space). */
export function emailFromLink(query) {
  try {
    const q = String(query || '').replace(/^[^?]*\?/, '');
    const raw = new URLSearchParams(q).get('e') || '';
    const v = raw.replace(/ /g, '+').trim();
    return EMAIL.test(v) ? v : '';
  } catch (_) { return ''; }
}

/* The body of the host's public route. Returns { status, body }; the host sends it. `provider` is a provider. A
   honeypot hit answers ok without doing anything. A failure answers a plain message, never the service's own error
   text, which can quote the request back. */
export async function handleUnsubscribe(provider, input) {
  if (typeof provider?.unsubscribeByEmail !== 'function') return { status: 501, body: { error: 'That is not switched on here.' } };
  const body = input && typeof input === 'object' ? input : {};
  if (String(body.company || '').trim()) return { status: 200, body: { ok: true } };
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) return { status: 422, body: { error: 'That does not look like an email address.' } };
  if (typeof provider.connected === 'function' && !provider.connected()) return { status: 503, body: { error: 'That did not go through. Try again in a moment.' } };
  try {
    await provider.unsubscribeByEmail(email);
  } catch (_) {
    return { status: 502, body: { error: 'That did not go through. Try again in a moment.' } };
  }
  return { status: 200, body: { ok: true } };
}
