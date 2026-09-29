/*
  Text rules shared by mentions.js, tags.js, notifications.js and push.js. Internal: not exported
  from index.js, so these can change without a version bump.
*/

/* Fold case and accents so "José" matches "@jose" and "#Café" is "#cafe". */
export const fold = (v) => String(v ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

/* fold(), plus where each folded character came from, so a match found in the folded text can be
   reported as a position in the original. Folding can change the length: a separately typed accent
   ("e" + U+0301) folds to nothing, and some letters lower-case or decompose into more than one
   character. `at[i]` is the original index of folded character i; `at[folded.length]` is the
   original length, so `at[end]` is a valid end for a match that runs to the last character. */
export function foldWithMap(value) {
  const s = String(value ?? '');
  let folded = '';
  const at = [];
  let i = 0;
  for (const ch of s) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k += 1) at.push(i);
    folded += f;
    i += ch.length;
  }
  at.push(s.length);
  return { folded, at };
}

/* What may come right before an "@" that starts a mention or a group tag: not a word character, so
   "someone@example.com" is not one, and not "@", "." or "-". A regular-expression source. */
export const AT_BOUNDARY = '(^|[^\\w@.-])';

/* One line of text, cut at `max` characters with an ellipsis: the body of a push. */
export function oneLine(value, max) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
}
