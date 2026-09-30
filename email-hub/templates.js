/*
  Provider templates, so a draft's review can show the email as it will be sent.

  Some services (Kit) keep an email's design in a template of their own and add it only when they send. Their API returns
  the message text but never the template, so a review of the draft shows a few bare lines. The host copies the template's
  HTML in as `templates` and the hub drops the draft's own message into it, as the service will. The copy is the host's to
  keep in step with the service: it is a preview, and the service's own preview or a test email stays the last word.

  createEmailHub({ templates: { 'Template name': '<html>…{{ message_content }}…</html>' }, defaultTemplate: 'Template name' })
  The provider says which template an email uses (campaignContent().template, a name); defaultTemplate covers a service that
  does not, or an email that uses the account default. Names match ignoring case and surrounding space.
*/
const norm = (s) => String(s || '').trim().toLowerCase();

/* { name, html } for the template this email uses, or null when the host has no copy of it. */
export function pickTemplate(templates, name, defaultName = '') {
  if (!templates || typeof templates !== 'object') return null;
  const by = new Map(Object.entries(templates).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [norm(k), { name: k, html: v }]));
  return by.get(norm(name)) || by.get(norm(defaultName)) || null;
}

/* Fills the merge tags a template can carry. Tags the hub cannot know are left empty, never shown as raw {{ }}. */
export function renderTemplate(html, { message = '', address = '', email = 'you@example.org' } = {}) {
  const values = { message_content: message, address, subscriber_preferences_url: '#', 'subscriber.email_address': email, unsubscribe_url: '#' };
  return String(html).replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, k) => (k in values ? values[k] : ''));
}
