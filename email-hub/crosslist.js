/*
  Sending one email to two lists without anyone getting it twice (see accounts.js, which serves it as `/both`).

  The first list gets the email. The second list gets it too, except for anyone who is already on the first. To say "except", the
  second account marks those people with a tag (`Also on <first list>`) and its email is addressed to everyone except that tag.

    const both = createCrossList({ primary, secondary, tagName: 'Also on Main list' });   // two providers
    await both.plan();                       // read-only: how many are on both
    let r = await both.mark({ after: '' });  // tag the people on both, in bounded slices; call again with r.next until it is null

  How it stays correct:
  - A person counts as "on the first list" only if they are *subscribed* there. Someone who unsubscribed from the first list is
    still sent the second list's email: they never get the first.
  - Marking is repeatable, and it also removes the tag from anyone who has since left the first list, so nobody is left out of both.
  - The tag is only ever added to or removed from people on the second list. Nothing is sent and the first list is only read.
  - Kit sends to one filter kind per email, so the second email is "everyone except the tag": it cannot also be narrowed to a
    tag or segment of the second list (the provider refuses that instead of sending to the wrong people).
  - Lists are compared by reading every subscribed address (1000 a call). Past `maxContacts` a list is too large to compare here.
  - Mark again right before scheduling: people who joined or left the first list since the last mark are not counted until then.
*/
import { HubError } from './provider.js';

const PAGE = 1000;
const COST = { tag: 2, untag: 1 };       // provider calls: Kit looks the person up before it tags

const enc = (v) => encodeURIComponent(String(v ?? ''));
export function readMarkCursor(after) {
  const m = /^([mc])~([^~]*)~(\d{1,5})$/.exec(String(after ?? ''));
  return m ? { phase: m[1], token: decodeURIComponent(m[2]), index: Number(m[3]) } : { phase: 'm', token: '', index: 0 };
}
const markCursor = (phase, token, index) => `${phase}~${enc(token)}~${index}`;

export function createCrossList({ primary, secondary, tagName = '', budget = 40, maxContacts = 30000 } = {}) {
  if (!primary || !secondary) throw new Error('createCrossList needs a primary and a secondary provider.');
  if (primary === secondary) throw new Error('The two lists must be different accounts.');
  for (const [k, p] of [['primary', primary], ['secondary', secondary]]) if (typeof p.listContacts !== 'function') throw new Error(`The ${k} provider cannot list contacts.`);
  const name = String(tagName || `Also on ${primary.label}`).trim().slice(0, 100);
  const need = (p, cap, what) => { if (typeof p[cap] !== 'function') throw new HubError(`${p.label} cannot ${what} from here.`, 405); };

  /* Every subscribed address on a list, lower case. Returns { set, calls }. */
  async function addressesOf(provider) {
    const set = new Set(); let after = '', calls = 0;
    for (let page = 0; page < Math.ceil(maxContacts / PAGE) + 1; page++) {
      const r = await provider.listContacts({ status: 'subscribed', after, perPage: PAGE }); calls++;
      for (const c of r.contacts || []) if (c.email) set.add(String(c.email).toLowerCase());
      if (set.size > maxContacts) throw new HubError('That list is too large to compare here.', 413);
      if (!r.next) return { set, calls };
      after = r.next;
    }
    throw new HubError('That list is too large to compare here.', 413);
  }
  const tag = async () => (await secondary.createTag(name)).tag;

  /* Only people who can be emailed (subscribed) are counted, on each list and across both. */
  async function plan() {
    const first = await addressesOf(primary);
    let overlap = 0, second = 0, after = '';
    for (let page = 0; page < Math.ceil(maxContacts / PAGE) + 1; page++) {
      const r = await secondary.listContacts({ status: 'subscribed', after, perPage: PAGE });
      for (const c of r.contacts || []) { second++; if (first.set.has(String(c.email).toLowerCase())) overlap++; }
      if (!r.next) break;
      after = r.next;
    }
    const unique = first.set.size + second - overlap;
    const plural = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`;
    return {
      primary: { label: primary.label, canEmail: first.set.size },
      secondary: { label: secondary.label, canEmail: second },
      onBoth: overlap,
      secondGets: second - overlap,
      uniquePeople: unique,
      tag: name,
      summary: `${plural(first.set.size)} can be emailed on the first list and ${plural(second)} on the second. ${plural(overlap)} ${overlap === 1 ? 'is' : 'are'} on both, so sending to both lists reaches ${plural(unique)}, and each gets one email.`,
    };
  }

  /* One bounded slice of marking. Phase m tags the second list's people who are on the first; phase c then removes the tag from
     anyone tagged who is no longer on the first. `next` is null when both phases are done. */
  async function mark({ after = '' } = {}) {
    need(secondary, 'tagContact', 'tag people'); need(secondary, 'createTag', 'make a tag');
    const cur = readMarkCursor(after);
    const first = await addressesOf(primary);
    let calls = first.calls;
    const t = await tag(); calls++;
    const out = { tagged: 0, untagged: 0, checked: 0, failed: 0, tag: { id: String(t.id), name: t.name } };
    let { phase, token, index } = cur;

    for (let guard = 0; guard < 200; guard++) {
      const r = await secondary.listContacts({ status: 'subscribed', after: token, perPage: PAGE, ...(phase === 'c' ? { tag: t.id } : {}) });
      const rows = r.contacts || [];
      let i = index;
      for (; i < rows.length; i++) {
        const c = rows[i], on = first.set.has(String(c.email).toLowerCase());
        const cost = phase === 'm' ? COST.tag : COST.untag;
        const needsCall = phase === 'm' ? on : !on;
        if (needsCall && calls + cost > budget && (out.tagged + out.untagged + out.failed) > 0) return { ...out, next: markCursor(phase, token, i) };
        out.checked++;
        if (!needsCall) continue;
        try { await secondary.tagContact(c.id, name, phase === 'm'); calls += cost; phase === 'm' ? out.tagged++ : out.untagged++; } catch { out.failed++; calls += cost; }
      }
      if (r.next) { token = r.next; index = 0; if (calls >= budget) return { ...out, next: markCursor(phase, token, 0) }; continue; }
      if (phase === 'm') { phase = 'c'; token = ''; index = 0; if (calls >= budget) return { ...out, next: markCursor('c', '', 0) }; continue; }
      return { ...out, next: null };
    }
    return { ...out, next: markCursor(phase, token, index) };
  }

  return { plan, mark, tag, name };
}
