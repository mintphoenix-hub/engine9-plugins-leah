/*
  Email HTML pasted in by a person (from a designer, or an email builder), rather than written plainly in the hub.

  It is sent exactly as pasted: the hub does not wrap it in its own logo, footer or unsubscribe line. So two things are
  checked before anything is saved:
    - the message is safe to store and show: scripts, frames, forms, plug-ins, event handlers and javascript: links are
      removed (the preview frame cannot run scripts either; this is a second lock, and the service cleans it again);
    - the message carries the service's unsubscribe tag. Every marketing email must let a person opt out, and the service
      will refuse to send one that cannot.
  The postal address is only warned about, because the service's checklist enforces it at send time.
*/
export const MAX_HTML = 200000;

const BLOCK_TAGS = 'script|iframe|frame|frameset|object|embed|applet|form|base|meta|link|noscript|template|svg|math|audio|video|canvas|dialog|portal';

export function cleanEmailHtml(input) {
  let h = String(input ?? '').replace(/\u0000/g, '').slice(0, MAX_HTML);
  h = h.replace(/<!--(?!\s*\[if)[\s\S]*?-->/g, '');                                            // comments, but keep Outlook's [if] blocks
  h = h.replace(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');     // paired tags with their contents
  h = h.replace(new RegExp(`<\\/?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '');                       // any left over, or self-closing
  h = h.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');                          // onclick=, onerror= ...
  h = h.replace(/\s(href|src|action|formaction|xlink:href|background)\s*=\s*("|')\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"']*\2/gi, ' $1=$2#$2');
  h = h.replace(/\s(href|src)\s*=\s*(?:javascript|vbscript):[^\s>]*/gi, ' $1="#"');
  h = h.replace(/expression\s*\(|behaviou?r\s*:|-moz-binding/gi, '');                          // old script-in-CSS tricks
  return h.trim();
}

/* What is wrong with a pasted email, as plain sentences. `errors` stop it being saved; `warnings` are shown. */
export function checkEmailHtml(html, { unsubscribe = '', address = '' } = {}) {
  const errors = [], warnings = [];
  const text = String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\*\|[^|]*\|\*|\{\{[^}]*\}\}/g, ' ').trim();   // a merge tag alone is not a message
  if (!text) errors.push('That HTML has no words in it. Paste the whole email, from its opening tag to its closing one.');
  if (unsubscribe && !String(html).includes(unsubscribe)) errors.push(`An email needs an unsubscribe link. Add ${unsubscribe} as the address of a link (for example: <a href="${unsubscribe}">Unsubscribe</a>).`);
  if (address && !String(html).includes(address) && !/\bPalmwoods|\bQLD\b|\bNSW\b|\bVIC\b|\bSA\b|\bWA\b|\bTAS\b|\bNT\b|\bACT\b|\bAustralia\b/i.test(text)) warnings.push(`There is no postal address in it. You can add ${address}, which the service fills in for you.`);
  if (/<img\b[^>]*\ssrc=["']?(?!https:|\*\||\{\{|cid:|data:)[^"'\s>]+/i.test(html)) warnings.push('Some pictures use an address that is not a full https:// link, so they will not show in a person\'s inbox.');
  return { errors, warnings };
}
