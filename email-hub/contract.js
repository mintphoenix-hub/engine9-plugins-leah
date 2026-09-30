/*
  What a provider must return, as checks. A provider passes `assertProvider` if it has the right calls; these say
  whether the things those calls return have the right shape, which is what the screens rely on. Each returns a list of
  problems (empty means fine), so a new adapter's tests can run them over real output. Pure.
*/
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => v === null || v === undefined || isNum(v);
const strOrNull = (v) => v === null || v === undefined || typeof v === 'string';
const rate = (v) => v === null || v === undefined || (isNum(v) && v >= 0 && v <= 1);

export const CAMPAIGN_STATUS = ['save', 'paused', 'schedule', 'sending', 'sent'];
export const CONTACT_STATE = ['subscribed', 'unsubscribed', 'cleaned', 'pending'];

export function problemsWithCampaign(c) {
  const p = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  if (typeof c.id !== 'string' || !c.id) p.push('id must be a non-empty string');
  if (!CAMPAIGN_STATUS.includes(c.status)) p.push(`status "${c.status}" is not one of ${CAMPAIGN_STATUS.join(', ')}`);
  for (const k of ['subject', 'title', 'preview', 'audience', 'segment']) if (typeof c[k] !== 'string') p.push(`${k} must be a string`);
  for (const k of ['recipients', 'sent']) if (!numOrNull(c[k])) p.push(`${k} must be a number or null`);
  for (const k of ['openRate', 'clickRate']) if (!rate(c[k])) p.push(`${k} must be a fraction from 0 to 1, or null (not a percentage)`);
  if (!c.stats || !numOrNull(c.stats.opened) || !numOrNull(c.stats.clicked)) p.push('stats must be { opened, clicked } as numbers or null');
  for (const k of ['created', 'when', 'archiveUrl', 'editUrl']) if (!strOrNull(c[k])) p.push(`${k} must be a string or null`);
  return p;
}

export function problemsWithContact(c) {
  const p = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  if (typeof c.id !== 'string' || !c.id) p.push('id must be a non-empty string');
  if (typeof c.email !== 'string' || !c.email.includes('@')) p.push('email must be an address');
  for (const k of ['first', 'last']) if (typeof c[k] !== 'string') p.push(`${k} must be a string`);
  if (!CONTACT_STATE.includes(c.state)) p.push(`state "${c.state}" is not one of ${CONTACT_STATE.join(', ')}`);
  if (!Array.isArray(c.tags) || c.tags.some((t) => typeof t?.name !== 'string' || t.id == null)) p.push('tags must be a list of { id, name }');
  if (!strOrNull(c.created)) p.push('created must be a string or null');
  return p;
}

export function problemsWithAudience(a) {
  const p = [];
  if (!a || typeof a !== 'object') return ['not an object'];
  if (!numOrNull(a.subscribers)) p.push('subscribers must be a number or null');
  for (const k of ['tags', 'segments']) {
    if (!Array.isArray(a[k])) { p.push(`${k} must be a list`); continue; }
    for (const t of a[k]) if (t.id == null || typeof t.name !== 'string' || !numOrNull(t.count)) p.push(`each of ${k} needs { id, name, count }`);
  }
  return p;
}

export function problemsWithCounts(c) {
  return !c || typeof c !== 'object' ? ['not an object'] : CONTACT_STATE.filter((k) => !numOrNull(c[k]) || !(k in c)).map((k) => `${k} must be a number or null`);
}

export function problemsWithReport(r) {
  return !r || typeof r !== 'object' ? ['not an object'] : ['recipients', 'opened', 'clicked', 'unsubscribed', 'bounced'].filter((k) => !numOrNull(r[k])).map((k) => `${k} must be a number or null`).concat(rate(r.openRate) && rate(r.clickRate) ? [] : ['rates must be fractions']);
}
