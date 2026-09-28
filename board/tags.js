/*
  Tags: group tags and topic hashtags in a post's text.

  Pure and storage-free, like mentions.js. Two kinds:

    @group   names a set of people the host defines (@writers, @cast). A group tag notifies
             every member, the way an @mention notifies one person.
    #topic   labels the post (#props, #costumes). People follow a topic to hear about new
             posts carrying it; anyone can filter the board by it.

  Both are stored as rows (`post_tag`), and whoever ends up notified is written as `mention`
  rows with `via_tag` set, so the same unread count and notification path serve mentions,
  groups and followed topics alike.

  Tag names are lower-case ASCII letters, digits, `_` and `-`, starting with a letter, at most
  40 long. Accents are folded ("Café" is #cafe) so the same word is the same tag however it
  was typed, and so a tag is always safe in a URL.
*/

const MAX_TAG = 40;

const fold = (v) => String(v == null ? '' : v)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase();

/* A tag as stored, or '' if what was given cannot be one. */
export function normalizeTag(value) {
  const t = fold(value).replace(/^[#@]/, '').replace(/[^a-z0-9_-]/g, '');
  return /^[a-z]/.test(t) ? t.slice(0, MAX_TAG) : '';
}

/* The #topics in a body, once each, in the order they first appear.

   The character before the # must not be a word character, '&' or '/', so an HTML entity
   ("&#39;"), a URL fragment ("page#top") and "C#" are not topics. */
export function parseHashtags(body) {
  const text = fold(body);
  if (!text.includes('#')) return [];
  const found = [];
  const re = /(^|[^\w&#/])#([a-z][a-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = normalizeTag(m[2]);
    if (tag && !found.includes(tag)) found.push(tag);
  }
  return found;
}

/* Which of the host's group tags a body names. `groups` is a list of names (or objects with a
   `tag`). Same boundary rules as a mention, so "@writers" does not fire inside "@writersroom"
   and an address like "a@cast.com" is not a tag. */
export function parseGroupTags(body, groups = []) {
  const text = fold(body);
  if (!text.includes('@')) return [];
  const found = [];
  for (const g of groups) {
    const name = normalizeTag(typeof g === 'string' ? g : g?.tag);
    if (!name || found.includes(name)) continue;
    if (new RegExp(`(^|[^\\w@.-])@${name}(?![\\w-])`).test(text)) found.push(name);
  }
  return found;
}

/* Where the tags are in the text, for highlighting. [{start, end, tag, kind}] */
export function findTags(body, groups = []) {
  const text = String(body || '');
  const folded = fold(text);
  const out = [];
  const names = groups.map((g) => normalizeTag(typeof g === 'string' ? g : g?.tag)).filter(Boolean);
  const re = /(^|[^\w&#/@.-])([#@])([a-z][a-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(folded)) !== null) {
    const kind = m[2] === '#' ? 'topic' : 'group';
    const tag = normalizeTag(m[3]);
    if (kind === 'group' && !names.includes(tag)) continue;
    const start = m.index + m[1].length;
    out.push({ start, end: start + 1 + m[3].length, tag, kind });
  }
  return out;
}

/* The post_tag rows for one post. */
export function tagRows(postId, { groups = [], topics = [] } = {}) {
  return [
    ...groups.map((tag) => ({ post_id: postId, tag, kind: 'group' })),
    ...topics.map((tag) => ({ post_id: postId, tag, kind: 'topic' })),
  ];
}

/* The mention rows for everyone a post's tags reach, skipping people already named directly
   (`alreadyNotified`, a set of person ids) and the author. `reached` is
   [{tag, kind, personIds}] — the host works out who is in each group or follows each topic.
   A person reached two ways is written once, under the first tag that reached them. */
export function tagMentionRows(postId, reached = [], { alreadyNotified = new Set(), authorPersonId = 0 } = {}) {
  const seen = new Set(alreadyNotified);
  if (authorPersonId) seen.add(authorPersonId);
  const rows = [];
  for (const r of reached) {
    for (const personId of r.personIds || []) {
      if (!personId || seen.has(personId)) continue;
      seen.add(personId);
      rows.push({ post_id: postId, person_id: personId, via_tag: r.kind === 'topic' ? `#${r.tag}` : `@${r.tag}` });
    }
  }
  return rows;
}

export default { normalizeTag, parseHashtags, parseGroupTags, findTags, tagRows, tagMentionRows };
