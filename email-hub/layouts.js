/*
  Layouts: emails a host has designed once, made by filling in fields.

  A host gives the hub a fixed design, such as a show announcement, as a layout: the fields a person fills in, and a function
  that turns their values into the whole email. Create email then offers it beside "Write it", the values are kept with the
  email, and a draft (or a duplicate of one) is changed by editing the fields, not the HTML.

    createEmailHub({ layouts: { show: {
      label: 'New show', description: 'The show announcement.',
      fields: [{ key: 'title', label: 'Show title', type: 'text', group: 'The show', placeholder: 'Cluelesque', required: true }, ...],
      render: (values, { style, mergeTags, brand }) => '<html>…</html>'   // the whole email, escaping the values itself
    } } })

  Field types: text (one line), longtext (paragraphs), url (an https:// address, or empty). Every value is clipped and checked
  here before the host's render sees it, and only declared fields get through. The output is checked like any email: it must
  carry the service's unsubscribe tag.
*/
import { HubError } from './provider.js';
import { checkEmailHtml } from './pasted.js';

const LIMITS = { text: 300, longtext: 8000, url: 600 };
const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;
const ID = /^[a-z][a-z0-9-]{0,29}$/;

/* Throws on a layout that cannot work, at start-up rather than the first time someone opens Create. */
export function checkLayouts(layouts) {
  for (const [id, l] of Object.entries(layouts || {})) {
    if (!ID.test(id)) throw new Error(`layout id "${id}" must be lower-case letters, digits and hyphens`);
    if (!l || typeof l.render !== 'function' || !Array.isArray(l.fields) || !l.label) throw new Error(`layout "${id}" needs a label, fields and a render function`);
    const seen = new Set();
    for (const f of l.fields) {
      if (!KEY.test(f.key || '') || seen.has(f.key)) throw new Error(`layout "${id}" has a missing or repeated field key "${f.key}"`);
      if (!LIMITS[f.type || 'text']) throw new Error(`layout "${id}" field "${f.key}" has an unknown type`);
      seen.add(f.key);
    }
  }
}

/* What the screens need: no functions. */
export function listLayouts(layouts) {
  return Object.entries(layouts || {}).map(([id, l]) => ({
    id, label: l.label, description: l.description || '',
    fields: l.fields.map((f) => ({ key: f.key, label: f.label || f.key, type: f.type || 'text', group: f.group || '', hint: f.hint || '', placeholder: f.placeholder || '', required: Boolean(f.required) }))
  }));
}

const isHttps = (u) => /^https:\/\/[^\s"'<>]+$/i.test(u);

/* Only declared fields; strings; clipped; urls must be https or empty. `required` fields must be filled unless `partial`
   (a live preview of a form half filled in). */
export function cleanValues(layout, input, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const f of layout.fields) {
    const type = f.type || 'text';
    let v = src[f.key] == null ? '' : String(src[f.key]).replace(/\u0000/g, '');
    v = type === 'longtext' ? v.replace(/\r\n?/g, '\n').slice(0, LIMITS.longtext).trim() : v.replace(/\s+/g, ' ').slice(0, LIMITS[type]).trim();
    if (type === 'url' && v && !isHttps(v)) { if (partial) v = ''; else throw new HubError(`${f.label || f.key}: use a full https:// address.`); }
    if (f.required && !v && !partial) throw new HubError(`${f.label || f.key} is needed.`);
    out[f.key] = v;
  }
  return out;
}

/* The email for these values. Refuses one that could not be sent (no unsubscribe tag). */
export function renderLayout(layout, values, ctx, { check = true } = {}) {
  const html = String(layout.render(values, ctx) || '');
  if (!html.trim()) throw new HubError('That layout made an empty email.', 500);
  if (check) {
    const found = checkEmailHtml(html, { unsubscribe: ctx.mergeTags?.unsubscribe, address: ctx.mergeTags?.address });
    if (found.errors.length) throw new HubError(found.errors[0], 500);
  }
  return html;
}
