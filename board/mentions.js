/*
  Mentions: turning "@name" in a post into the person it names.

  Pure and storage-free on purpose. The host knows how to read its own people and how to send
  its own notifications; what is easy to get subtly wrong is the MATCHING, and that is what
  lives here so every host gets the same answer:

    - the longest handle wins, so "@MaryAnne" is never read as "@Mary";
    - a mention ends at a word boundary, so "@Meg" does not fire inside "@Megan" and "@Julia"
      does not swallow "@Julianna";
    - an address in prose ("mail me @ home", "someone@example.com") is not a mention;
    - matching is case- and accent-insensitive, because nobody types the accent.

  A mention is stored as a PERSON ID, never as the text somebody typed. That is what makes it
  notifiable, and it is also what keeps a real name out of any record that might be exported:
  the id is the fact, the spelling is just what one person typed once.
*/

/* Fold case and accents so "José" matches "@jose". Kept to the characters a handle can hold. */
const fold = (v) => String(v == null ? '' : v)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase();

const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* What somebody types after the @.

   A first name where there is one, because that is what people call each other. It falls back
   to the display name with the spaces taken out, which is unambiguous by construction when
   display names are unique. `taken` is the handles already used: a second Julia gets her
   display name instead, so two people never answer to the same @.

   Somebody with no first name recorded gets the first word of their display name — "Alex
   Fontaine" answers to @Alex — which is what a team already calls them. `isExternal` marks the
   people a host keeps as names rather than accounts (contractors, volunteers, external
   collaborators); they are handled the same way. */
export function handleFor(person, taken = new Set()) {
  const first = (person.firstName || '').trim();
  const display = String(person.displayName || person.name || '').trim();
  const squashed = display.replace(/\s+/g, '');
  const firstWord = display.split(/\s+/)[0] || squashed;

  const preferred = first || (person.isExternal ? firstWord : squashed);
  if (!preferred) return '';
  return taken.has(fold(preferred)) ? (squashed || preferred) : preferred;
}

/* Give every person a handle, resolving collisions in the order they arrive. Mutates nothing:
   returns a new array with `handle` set. */
export function withHandles(people = []) {
  const taken = new Set();
  return people.map((p) => {
    const handle = handleFor(p, taken);
    if (handle) taken.add(fold(handle));
    return { ...p, handle };
  });
}

/* Who a body of text names. Returns the people's ids, in the order the handles were given.

   `people` is `[{id, handle}]` — whatever else rides along is ignored, so a host can pass its
   own records straight in. */
export function parseMentions(body, people = []) {
  const text = fold(body);
  if (!text.includes('@')) return [];
  const found = new Set();
  // Longest first: "@MaryAnne" must not be consumed by a shorter "@Mary".
  const byLength = [...people].filter((p) => p && p.handle).sort((a, b) => b.handle.length - a.handle.length);
  for (const p of byLength) {
    /* (^|[^\w@.-]) keeps an email address from reading as a mention: the character before the
       @ in "someone@example.com" is a word character, so it never starts one. */
    const re = new RegExp(`(^|[^\\w@.-])@${escapeRe(fold(p.handle))}(?![\\w-])`);
    if (re.test(text)) found.add(p.id);
  }
  return [...found];
}

/* Where the mentions are in the text, for highlighting. Returns [{start, end, handle, id}].
   Overlaps are resolved the same way parseMentions resolves them: longest handle wins. */
export function findMentions(body, people = []) {
  const text = String(body || '');
  const folded = fold(text);
  const out = [];
  const byLength = [...people].filter((p) => p && p.handle).sort((a, b) => b.handle.length - a.handle.length);
  for (const p of byLength) {
    const re = new RegExp(`(^|[^\\w@.-])@${escapeRe(fold(p.handle))}(?![\\w-])`, 'g');
    let m;
    while ((m = re.exec(folded)) !== null) {
      const start = m.index + m[1].length;
      const end = start + 1 + p.handle.length;
      if (!out.some((o) => start < o.end && end > o.start)) out.push({ start, end, handle: p.handle, id: p.id });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* Anything that LOOKS like a mention, whether or not it names somebody this host knows.
   For a composer that highlights as you type without being handed the people list — the
   server still decides who was actually named. */
export const MENTION_PATTERN = /(^|[^\w@.-])@([\p{L}][\p{L}\p{N}_-]*)/gu;

/* The rows a host should write for one post. `personIdOf` maps the host's own person key to
   the id stored on the mention; ids that resolve to nothing are dropped, because a mention
   that reaches nobody is not worth a row. */
export function mentionRows(postId, mentionedIds = [], personIdOf = (x) => x) {
  const seen = new Set();
  const rows = [];
  for (const id of mentionedIds) {
    const personId = personIdOf(id);
    if (!personId || seen.has(personId)) continue;
    seen.add(personId);
    rows.push({ post_id: postId, person_id: personId });
  }
  return rows;
}

/* The people an EDIT newly names: in the new body and not in the old one. Editing a post to add
   "@Ada" should tell Ada, and tidying a typo should not tell everyone again. Returns ids, in the
   order parseMentions gives them. */
export function addedMentions(beforeBody, afterBody, people = []) {
  const had = new Set(parseMentions(beforeBody, people));
  return parseMentions(afterBody, people).filter((id) => !had.has(id));
}

/* ---- the composer: suggesting a name after "@" ---------------------------------------------
   The same rules as matching, applied while somebody is still typing, so every host's picker
   offers what the server will actually recognise. Pure: text and a caret in, a suggestion or a
   new text and caret out. The host draws the list and owns the keys. */

/* Is the caret sitting right after "@partial"? Returns { start, query } — `start` is where the
   "@" is — or null. An "@" that follows a word character (an email address) is not a mention. */
export function mentionQuery(text, caret = String(text || '').length) {
  const upto = String(text || '').slice(0, caret);
  const m = /(^|[^\w@.-])@([\p{L}][\p{L}\p{N} _-]{0,39}|)$/u.exec(upto);
  return m ? { start: upto.length - m[2].length - 1, query: m[2] } : null;
}

/* Who to offer for what has been typed after the "@". `people` is `[{id, handle}]`. Prefix match,
   case- and accent-insensitive; someone already typed out in full is not offered again, and
   `exclude` (ids) drops people such as the author. */
export function suggestMentions(query, people = [], { limit = 5, exclude = [] } = {}) {
  const q = fold(query);
  const skip = new Set(exclude);
  const seen = new Set();
  return people
    .filter((p) => p && p.handle && !skip.has(p.id) && !seen.has(fold(p.handle)) && seen.add(fold(p.handle)))
    .filter((p) => fold(p.handle).startsWith(q) && fold(p.handle) !== q)
    .sort((a, b) => a.handle.length - b.handle.length || fold(a.handle).localeCompare(fold(b.handle)))
    .slice(0, limit);
}

/* Write the chosen handle in place of what was typed: "@Ad" becomes "@Ada ". Returns the new
   text and where the caret belongs. */
export function applyMention(text, caret, mention, handle) {
  const before = String(text || '').slice(0, mention.start);
  const after = String(text || '').slice(caret);
  const inserted = `@${handle} `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

export default { handleFor, withHandles, parseMentions, findMentions, mentionRows, addedMentions, mentionQuery, suggestMentions, applyMention, MENTION_PATTERN };
