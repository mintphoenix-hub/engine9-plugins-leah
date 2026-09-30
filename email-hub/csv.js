/* Reading a CSV of people, and cleaning it. Pure: it runs in the browser and in a Worker. */

export const MAX_IMPORT = 5000;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
export const isEmail = (s) => EMAIL.test(String(s || ''));

/* Trimmed, lower-cased, one row per address, valid only. */
export function cleanPeople(people) {
  const seen = new Map();
  let invalid = 0;
  for (const p of Array.isArray(people) ? people : []) {
    const email = String(p?.email || '').trim().toLowerCase();
    if (!isEmail(email)) { invalid++; continue; }
    if (seen.has(email)) continue;
    seen.set(email, { email, first: String(p.first || '').trim().slice(0, 80), last: String(p.last || '').trim().slice(0, 80) });
  }
  return { people: [...seen.values()], invalid };
}

/* Quoted fields, commas inside quotes, a header row or none. */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => c.trim()));
  if (!clean.length) return { people: [] };
  const isMail = (s) => /@/.test(s);
  const head = clean[0].map((h) => h.trim().toLowerCase());
  const headless = clean[0].some(isMail);
  let e = head.findIndex((h) => /e-?mail/.test(h));
  if (e < 0) e = headless ? clean[0].findIndex(isMail) : clean[1] ? clean[1].findIndex(isMail) : -1;
  const f = head.findIndex((h) => /first/.test(h)), l = head.findIndex((h) => /last|surname|family/.test(h));
  const body = headless ? clean : clean.slice(1);
  return {
    people: e < 0 ? [] : body.map((r) => ({ email: (r[e] || '').trim(), first: f >= 0 ? (r[f] || '').trim() : '', last: l >= 0 ? (r[l] || '').trim() : '' })).filter((p) => p.email),
    column: headless ? `column ${e + 1}` : clean[0][e]
  };
}
