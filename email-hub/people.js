/*
  The email hub's connection to engine9 core's people.

  Core keeps its own record of every person and of whether each of their addresses may be emailed: `person` and `person_email`
  (the standard tables of `@engine9/interfaces/person` and `person_email`), with `person_email.subscription_status` one of
  Subscribed, Unsubscribed, Not Subscribed, Bouncing, Spam. The email service (Kit, Mailchimp) keeps its own list. When the two
  disagree, anything that reads core goes on treating a person who left as reachable, so the hub tells core whenever it changes who
  is on the list.

    const people = createCorePeople({ db });                     // db is D1-shaped: db.prepare(sql).bind(...).first() / .run()
    const hub = createEmailHub({ provider, brand, store, people });

  The hub calls it for you:
    - a person unsubscribes (the host's public page, or the Unsubscribe button on a contact)  ->  people.unsubscribe(email)
    - someone is added on the Audience screen, with the consent tick                            ->  people.subscribe({ email, first, last })
  Both run AFTER the service has accepted the change, and a failure here never undoes or hides it: it is logged (without the
  address) and the hub carries on. What the service accepted is what happened.

  It follows core's own rules, not a copy of them:
    - An address is matched the way core does: trimmed and lower-cased, by its text and by `email_hash_v1` (the sha256 of that).
    - An unsubscribe marks EVERY matching person_email row Unsubscribed (core's inbound upsert does the same), and only ever
      UPDATES: it never creates a row, because the public unsubscribe page accepts any address and must not be a way to write junk
      into the people table.
    - A subscribe creates the person and the address if core has neither, and moves a 'Not Subscribed' address to Subscribed. It
      NEVER changes Unsubscribed, Bouncing or Spam: somebody who left, or whose address fails, is not quietly put back.
    - Everyone is a `person` (core has no other word for a human being); a name is stored on `person`, never on the address.
  It needs no plugin of its own: it uses core's standard tables directly, which is why the plugin declares the person interface.
*/

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

/* Core's normalization: trim, then lower-case. */
export const normalizeEmail = (e) => String(e ?? '').trim().toLowerCase();

/* core's email_hash_v1: the sha256 of the normalized address, as hex. */
export async function emailHash(email) {
  const bytes = new TextEncoder().encode(normalizeEmail(email));
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);
const insertedId = (r) => Number(r?.meta?.last_row_id ?? r?.lastInsertRowid ?? r?.last_row_id ?? 0);
const clip = (v, n) => Array.from(String(v ?? '').trim()).slice(0, n).join('');

export function createCorePeople({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('email-hub: createCorePeople needs a database (db.prepare)');

  async function find(email) {
    const addr = normalizeEmail(email);
    if (!EMAIL.test(addr)) return null;
    const hash = await emailHash(addr);
    return db.prepare(
      `SELECT id, person_id, subscription_status FROM person_email WHERE email_hash_v1 = ? OR lower(trim(email)) = ? ORDER BY id LIMIT 1`,
    ).bind(hash, addr).first();
  }

  return {
    find,

    /* Every matching row becomes Unsubscribed. Returns how many changed (0 when core does not know the address, or already has it). */
    async unsubscribe(email) {
      const addr = normalizeEmail(email);
      if (!EMAIL.test(addr)) return 0;
      const hash = await emailHash(addr);
      const r = await db.prepare(
        `UPDATE person_email SET subscription_status = 'Unsubscribed', modified_at = CURRENT_TIMESTAMP
          WHERE (lower(trim(email)) = ? OR email_hash_v1 = ?) AND subscription_status <> 'Unsubscribed'`,
      ).bind(addr, hash).run();
      return changes(r);
    },

    /* Record consent to be emailed. Returns { personId, status, created } (status is what core holds afterwards). */
    async subscribe({ email, first = '', last = '' } = {}) {
      const addr = normalizeEmail(email);
      if (!EMAIL.test(addr)) return null;
      const hash = await emailHash(addr);
      const have = await find(addr);
      let personId = have?.person_id ? Number(have.person_id) : 0;
      let status = have?.subscription_status || null;
      let created = false;

      if (!have) {
        const p = await db.prepare(`INSERT INTO person (given_name, family_name) VALUES (?, ?)`).bind(clip(first, 100) || null, clip(last, 100) || null).run();
        personId = insertedId(p);
        await db.prepare(
          `INSERT INTO person_email (person_id, email_type, email, subscription_status, email_hash_v1, preference_order) VALUES (?, 'Personal', ?, 'Subscribed', ?, 0)`,
        ).bind(personId, addr, hash).run();
        status = 'Subscribed';
        created = true;
      } else if (status === 'Not Subscribed') {
        await db.prepare(`UPDATE person_email SET subscription_status = 'Subscribed', modified_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(have.id).run();
        status = 'Subscribed';
      }
      // Unsubscribed, Bouncing and Spam are left exactly as they are.

      // A name is only ever filled in, never overwritten: whoever holds the person record may have set it by hand.
      if (personId && (first || last)) {
        await db.prepare(
          `UPDATE person SET given_name = COALESCE(NULLIF(given_name, ''), ?), family_name = COALESCE(NULLIF(family_name, ''), ?) WHERE id = ?`,
        ).bind(clip(first, 100) || null, clip(last, 100) || null, personId).run();
      }
      return { personId, status, created };
    },
  };
}

/* A hook that must never break what it hangs off: log the failure's message (never the address) and carry on. */
export async function quietly(fn, label = 'people') {
  try { return await fn(); } catch (e) { console.error(`email-hub: ${label} failed:`, e?.message || e); return null; }
}
