/* Numbers for Home and Analytics, worked out from a list of campaigns. Pure. */

/* Emails sent in the last `days`: how many, how many messages, and open and click rates weighted by size. */
export function emailsIn(all, days, now = Date.now()) {
  const from = now - days * 86400_000;
  const rows = all.filter((c) => c.status === 'sent' && Date.parse(c.when) >= from);
  const sent = rows.reduce((n, c) => n + (c.sent || 0), 0);
  const weighted = (k) => {
    const r = rows.filter((c) => c[k] != null);
    const d = r.reduce((n, c) => n + (c.sent || 0), 0);
    return d ? r.reduce((n, c) => n + c[k] * (c.sent || 0), 0) / d : null;
  };
  return { emails: rows.length, sent, openRate: weighted('openRate'), clickRate: weighted('clickRate') };
}
