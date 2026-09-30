/*
  The look of every email the hub writes, and the pure functions that build it.

  Nothing here knows a site. The host passes its own `brand` ({ style, isLogoUrl }): its colours, logo and footer
  line become the defaults, and `isLogoUrl` says which logo addresses may be saved. The provider (Mailchimp, Kit)
  passes the merge tags for the postal address and the unsubscribe link, which every email carries. A host that runs its own
  unsubscribe page passes `siteUnsubscribe` (see unsubscribe.js): that becomes the one "Unsubscribe" link and the provider's
  own link stays underneath as a muted "Trouble unsubscribing?" line, because the provider requires it in every email.

  The browser preview imports this same file, so what she previews is what is saved.
*/

/* Neutral, so a site that sets no brand still gets a readable email. */
export const DEFAULT_STYLE = {
  ground: '#F1F3F4', card: '#FFFFFF', border: '#D9DEE0', accent: '#B7C4C8', text: '#22292C', muted: '#5B676C', link: '#2F5D7C',
  logoUrl: '', logoWidth: 220, footerLine: '', address: ''
};
export const STYLE_COLORS = ['ground', 'card', 'border', 'accent', 'text', 'muted', 'link'];

/* The defaults for one site: the neutral ones with the host's brand laid over them. */
export const defaultStyle = (brand = {}) => ({ ...DEFAULT_STYLE, ...(brand.style || {}) });

export class StyleError extends Error {
  constructor(message) { super(message); this.name = 'StyleError'; }
}

/* A complete, safe style, or a StyleError that says what was wrong. Colours are six-digit hex, the logo is one the
   host allows, the footer line is plain text. */
export function checkStyle(input, brand = {}) {
  const s = defaultStyle(brand);
  const i = input && typeof input === 'object' ? input : {};
  for (const k of STYLE_COLORS) {
    if (i[k] === undefined) continue;
    if (!/^#[0-9a-f]{6}$/i.test(String(i[k]))) throw new StyleError('Colours need to be picked from the colour box.');
    s[k] = String(i[k]).toUpperCase();
  }
  if (i.logoWidth !== undefined) {
    const w = Math.round(Number(i.logoWidth));
    if (!(w >= 80 && w <= 400)) throw new StyleError('The logo width needs to be between 80 and 400.');
    s.logoWidth = w;
  }
  if (i.logoUrl !== undefined) {
    const u = String(i.logoUrl);
    const ok = u === defaultStyle(brand).logoUrl || (typeof brand.isLogoUrl === 'function' && brand.isLogoUrl(u));
    if (!ok) throw new StyleError('Choose one of the logos shown.');
    s.logoUrl = u;
  }
  /* The sender's postal address, shown at the foot of every email. Empty means the service's own merge tag (the address
     saved in the service). Plain text only; it is escaped when the email is built. */
  if (i.address !== undefined) s.address = String(i.address).replace(/[\u0000-\u0009\u000b-\u001f<>]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ', ').trim().slice(0, 200);
  if (i.footerLine !== undefined) s.footerLine = String(i.footerLine).replace(/[\u0000-\u001f<>&"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || defaultStyle(brand).footerLine;
  return s;
}

export const emailShell = (inner, { address = '', unsubscribe = '', siteUnsubscribe = '', style = {}, brand = {} } = {}, k = { ...DEFAULT_STYLE, ...(brand.style || {}), ...style }) => `<div style="margin:0;padding:0;background-color:${k.ground}" bgcolor="${k.ground}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${k.ground}" style="background-color:${k.ground}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${k.card}" style="width:100%;max-width:600px;background-color:${k.card};border:1px solid ${k.border}"><tr><td align="center" style="padding:30px 24px 20px;border-bottom:1px solid ${k.accent}"><img src="${k.logoUrl}" alt="Loving Motion Kinesiology" width="${k.logoWidth}" style="display:block;width:${k.logoWidth}px;max-width:100%;height:auto;border:0"></td></tr><tr><td style="padding:34px 34px 10px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:${k.text}">${inner}</td></tr><tr><td align="center" style="padding:6px 34px 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="56" height="1" bgcolor="${k.accent}" style="width:56px;height:1px;line-height:1px;font-size:1px">&nbsp;</td></tr></table></td></tr><tr><td align="center" style="padding:0 34px 30px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:${k.muted}">${k.footerLine}<br>${k.address ? String(k.address).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : address}<br>${siteUnsubscribe ? `<a href="${siteUnsubscribe.replace(/"/g, '%22')}" style="color:${k.link}">Unsubscribe</a><br><span style="font-size:11px;color:${k.muted}">Trouble unsubscribing? <a href="${unsubscribe}" style="color:${k.muted};text-decoration:underline">Use this link</a>.</span>` : `<a href="${unsubscribe}" style="color:${k.link}">Unsubscribe</a>`}</td></tr></table></td></tr></table></div>`;

/* Plain words in, styled email HTML out. `inner` for the shell is the paragraphs; the whole page wraps it. */
export function paragraphs(text, style) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const link = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${style?.link || DEFAULT_STYLE.link};text-decoration:underline">$1</a>`);
  return String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 18px">${link(esc(p)).replace(/\n/g, '<br>')}</p>`).join('');
}
export function bodyHtml(text, opts = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${emailShell(paragraphs(text, opts.style), opts)}</body></html>`;
}
