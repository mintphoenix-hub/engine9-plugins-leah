/*
  Moving a list from one email service to another (optional; the host turns it on with `createEmailHub({ migrateFrom })`).
  Built for Mailchimp -> Kit, but it only uses the provider contract (provider.js), so any pair that has the calls works.

    const move = createMigration({ from: mailchimpProvider, to: kitProvider, store });
    await move.plan();                          // read-only: what would move and what would be left behind
    let r = await move.contacts({ after: '' }); // one slice of people; call again with r.next until it is null
    let a = await move.archive({ after: '' });  // the sent emails, into the hub's archive (store.saveArchived); same loop

  Rules it keeps (they are why this is safe to run, stop, and run again):
  - Only people who are `subscribed` move. Unsubscribed, cleaned and pending people stay behind, and are counted so nobody is
    surprised. The destination's own `addContact` never puts back someone who unsubscribed there (it says so in `note`).
  - Nothing is sent to anyone and nothing is changed in the source. Moving people does not email them.
  - Every call is bounded (`budget` provider calls) so it fits one Worker request; the cursor says where to carry on, and
    a repeat run only upserts, so it never duplicates.
  - A failure for one person is counted and the run carries on. The result never contains an address or a service's reply.
  - The sent emails go to the archive as read-only history (Kit cannot take sent emails), keyed by source + id, so running it twice
    updates the same rows.

  What does not move: drafts, templates, automations, last names (the Kit adapter keeps first names only) and each
  person's original signup date. A host that needs those carries them with its own importer.
*/
import { HubError } from './provider.js';
import { rate } from './helpers.js';

const DEFAULT_BUDGET = 40;     // provider calls in one request; Workers allow a limited number of subrequests
const ARCHIVE_STEP = 5;        // sent emails in one request (each needs its content, and a report when the service has one)

/* "12.3" (offset 12, 3 people already done on that page) -> { offset, index }. Anything else starts again at the top. */
export function readCursor(after) {
  const m = /^(\d{1,7})\.(\d{1,4})$/.exec(String(after ?? ''));
  return m ? { offset: Number(m[1]), index: Number(m[2]) } : { offset: 0, index: 0 };
}
const cursor = (offset, index) => `${offset}.${index}`;

export function createMigration({ from, to, store = null, source = '', budget = DEFAULT_BUDGET } = {}) {
  if (!from || !to) throw new Error('createMigration needs a `from` and a `to` provider.');
  const sourceName = String(source || from.label || 'import').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'import';
  const needFrom = (fn) => { if (typeof from[fn] !== 'function') throw new HubError(`${from.label} cannot do that from here.`, 405); };
  const needTo = (fn) => { if (typeof to[fn] !== 'function') throw new HubError(`${to.label} cannot do that from here.`, 405); };
  const sentOnly = (list) => (list || []).filter((c) => c && c.status === 'sent');

  async function plan() {
    needFrom('counts');
    const [counts, audience, listed] = await Promise.all([
      from.counts(),
      typeof from.audience === 'function' ? from.audience().catch(() => null) : null,
      typeof from.listCampaigns === 'function' ? from.listCampaigns().catch(() => null) : null,
    ]);
    const campaigns = listed?.campaigns || [];
    return {
      from: from.label,
      to: to.label,
      contacts: {
        willMove: counts?.subscribed ?? null,
        leftBehind: { unsubscribed: counts?.unsubscribed ?? 0, cleaned: counts?.cleaned ?? 0, pending: counts?.pending ?? 0 },
      },
      tags: audience?.tags?.length ?? null,
      emails: { sent: sentOnly(campaigns).length, notMoved: campaigns.length - sentOnly(campaigns).length, canArchive: Boolean(store?.saveArchived) },
      notMoved: ['drafts', 'templates', 'automations', 'last names', 'original signup dates'],
    };
  }

  /* One slice of the subscribed people. `next` is null when there are no more. */
  async function contacts({ after = '' } = {}) {
    needFrom('listContacts'); needTo('addContact');
    const { offset, index } = readCursor(after);
    let calls = 1;
    const page = await from.listContacts({ status: 'subscribed', after: offset ? String(offset) : '' });
    const rows = page.contacts || [];
    const out = { moved: 0, alreadyThere: 0, skipped: 0, failed: 0, tagged: 0, total: page.total ?? null };
    let i = index;
    for (; i < rows.length; i++) {
      const c = rows[i];
      const tags = (c.tags || []).map((t) => String(t.name || '').trim()).filter(Boolean);
      if (calls + 1 + Math.max(0, tags.length - 1) > budget && i > index) break;   // finish this request; resume at i
      if (c.state !== 'subscribed' || !c.email) { out.skipped++; continue; }
      try {
        const added = await to.addContact({ email: c.email, first: c.first || '', last: c.last || '', ...(tags[0] ? { tag: tags[0] } : {}) });
        calls++;
        if (added?.note) { out.alreadyThere++; continue; }   // they unsubscribed over there: they stay unsubscribed, and get no more tags
        out.moved++;
        if (tags[0]) out.tagged++;
        const id = added?.contact?.id;
        if (id && typeof to.tagContact === 'function') {
          for (const t of tags.slice(1)) { await to.tagContact(id, t, true); calls++; out.tagged++; }
        }
      } catch { out.failed++; }
    }
    const pageDone = i >= rows.length;
    const nextOffset = page.next != null ? Number(page.next) : null;
    const next = !pageDone ? cursor(offset, i) : nextOffset != null && Number.isFinite(nextOffset) ? cursor(nextOffset, 0) : null;
    return { ...out, next };
  }

  /* The sent emails into the hub's archive. `after` is how many have been done. */
  async function archive({ after = '' } = {}) {
    needFrom('listCampaigns'); needFrom('campaignContent');
    if (!store?.saveArchived) throw new HubError('There is nowhere to keep the old emails on this site.', 409);
    const start = Math.max(0, Number.parseInt(after, 10) || 0);
    const all = sentOnly((await from.listCampaigns()).campaigns).sort((a, b) => String(a.sent || a.when || '').localeCompare(String(b.sent || b.when || '')));
    const out = { archived: 0, failed: 0, total: all.length };
    const slice = all.slice(start, start + ARCHIVE_STEP);
    for (const c of slice) {
      try {
        const body = await from.campaignContent(c.id);
        const report = typeof from.campaignReport === 'function' ? await from.campaignReport(c.id).catch(() => null) : null;
        const sent = report?.recipients ?? c.recipients ?? null;
        const opened = report?.opened ?? c.stats?.opened ?? null;
        const clicked = report?.clicked ?? c.stats?.clicked ?? null;
        await store.saveArchived({
          source: sourceName, id: String(c.id), title: c.title || '', subject: c.subject || '', previewText: c.preview || '',
          sentAt: c.sent || c.when || null, audience: c.audience || '', segmentText: c.segment || '',
          emailsSent: sent, uniqueOpens: opened, clicks: clicked, openRate: rate(opened, sent), clickRate: rate(clicked, sent),
          archiveUrl: c.archiveUrl || null, html: body?.html || '',
        });
        out.archived++;
      } catch { out.failed++; }
    }
    const done = start + slice.length;
    return { ...out, next: done < all.length ? String(done) : null };
  }

  return { plan, contacts, archive };
}
