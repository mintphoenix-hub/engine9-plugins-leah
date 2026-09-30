/*
  A database-backed `store` for the hub (see routes.js): where the email look is kept, the logos that can be chosen
  for it, and an archive of a previous provider's sent emails. It implements the interface routes.js expects
  (loadStyle, saveStyle, resetStyle, logos) and adds the logo upload, serve and delete, and the archive.

    const store = createD1Store({ db, images, publicLogoBase: 'https://example.org/email-assets/', builtIn: [{ id, name, url }] });
    const brand = { isLogoUrl: store.isLogoUrl, ... };
    const hub = createEmailHub({ provider, brand, store });

  `db` is D1-shaped: db.prepare(sql).bind(...args) with .first(), .all() and .run(). The SQL is portable SQLite (D1,
  better-sqlite3); a host on another database passes a wrapper. `images` is R2-shaped: put(key, stream, {httpMetadata}),
  get(key), delete(key). Tables are schema.js's (engine9_email_hub_*).

  A logo is public on purpose (an email client cannot sign in to load a picture), so only files this store made are ever
  served, by an exact <uuid>.<ext> name under email-logos/, and every upload is checked by its first bytes, not its name.
*/
import { tableNames, toSqlTime } from './helpers.js';
import { HubError } from './provider.js';
import { MAX_LOGO_BYTES, LOGO_TYPES, LOGO_FILE, sniffImage, cleanLogoName } from './logos.js';

const COLUMNS = { ground: 'ground', card: 'card', border: 'border', accent: 'accent', text: 'text', muted: 'muted', link: 'link', logoUrl: 'logo_url', logoWidth: 'logo_width', footerLine: 'footer_line', font: 'font' };
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function createD1Store({ db, images = null, publicLogoBase = '', builtIn = [], tablePrefix = '' } = {}) {
  const T = tableNames(tablePrefix);
  const urlFor = (file) => `${publicLogoBase}${file}`;
  const isUpload = (u) => Boolean(publicLogoBase) && String(u).startsWith(publicLogoBase) && LOGO_FILE.test(String(u).slice(publicLogoBase.length));

  return {
    /* ---- the look (routes.js: loadStyle / saveStyle / resetStyle) */
    async loadStyle() {
      const row = await db.prepare(`SELECT * FROM ${T.style} WHERE slug = ?`).bind('house').first();
      if (!row) return null;
      const out = {};
      for (const [k, c] of Object.entries(COLUMNS)) if (row[c] != null && row[c] !== '') out[k] = k === 'logoWidth' ? Number(row[c]) : row[c];
      return Object.keys(out).length ? out : null;
    },
    async saveStyle(s) {
      await db.prepare(`INSERT OR IGNORE INTO ${T.style} (slug, name) VALUES (?, ?)`).bind('house', 'House style').run();
      const keys = Object.keys(COLUMNS);
      await db.prepare(`UPDATE ${T.style} SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')}, modified_at = datetime('now') WHERE slug = 'house'`)
        .bind(...keys.map((k) => (s[k] === undefined || s[k] === '' ? null : s[k]))).run();
    },
    async resetStyle() { await db.prepare(`DELETE FROM ${T.style} WHERE slug = ?`).bind('house').run(); },

    /* ---- the field values behind an email made from a host layout (layouts.js) */
    async getLayout(campaignId) {
      const row = await db.prepare(`SELECT layout, values_json FROM ${T.layout} WHERE campaign_id = ?`).bind(String(campaignId)).first();
      if (!row) return null;
      try { return { layout: row.layout, values: JSON.parse(row.values_json) }; } catch { return null; }
    },
    async saveLayout(campaignId, layout, values) {
      await db.prepare(`INSERT OR IGNORE INTO ${T.layout} (campaign_id, layout, values_json) VALUES (?, ?, ?)`).bind(String(campaignId), String(layout), JSON.stringify(values)).run();
      await db.prepare(`UPDATE ${T.layout} SET layout = ?, values_json = ?, modified_at = datetime('now') WHERE campaign_id = ?`).bind(String(layout), JSON.stringify(values), String(campaignId)).run();
    },
    /* A duplicate is the same fields under the new email's id. */
    async copyLayout(fromId, toId) {
      const one = await this.getLayout(fromId);
      if (one) await this.saveLayout(toId, one.layout, one.values);
    },
    async deleteLayout(campaignId) { await db.prepare(`DELETE FROM ${T.layout} WHERE campaign_id = ?`).bind(String(campaignId)).run(); },

    /* ---- logos: the built-in ones, then the uploads, newest first */
    async logos() {
      const { results } = await db.prepare(`SELECT id, name, object_key, bytes FROM ${T.logo} ORDER BY created_at DESC`).all();
      const up = (results || []).map((r) => ({ id: r.id, name: r.name, url: urlFor(r.object_key.slice('email-logos/'.length)), bytes: r.bytes, builtin: false }));
      return [...builtIn.map((l) => ({ ...l, builtin: true })), ...up];
    },
    /* For brand.isLogoUrl: an uploaded logo, or one of the built-in addresses. */
    isLogoUrl: (u) => isUpload(u) || builtIn.some((l) => l.url === u),
    async addLogo(file, name) {
      if (!images) throw new HubError('Image storage is not set up yet.', 503);
      if (!file || typeof file === 'string') throw new HubError('Choose a picture to upload.');
      if (file.size > MAX_LOGO_BYTES) throw new HubError('That picture is over 2 MB. A logo in an email should be small.');
      const type = sniffImage(await file.slice(0, 16).arrayBuffer());
      if (!type || !LOGO_TYPES[type]) throw new HubError('A PNG, JPEG, WebP or GIF picture, please.');
      const id = crypto.randomUUID();
      const key = `email-logos/${id}.${LOGO_TYPES[type]}`;
      await images.put(key, file.stream(), { httpMetadata: { contentType: type } });
      const n = cleanLogoName(name, file.name);
      await db.prepare(`INSERT INTO ${T.logo} (id, name, object_key, content_type, bytes) VALUES (?, ?, ?, ?, ?)`).bind(id, n, key, type, file.size).run();
      return { id, name: n, url: urlFor(`${id}.${LOGO_TYPES[type]}`), bytes: file.size, builtin: false };
    },
    /* Removing a logo the look is using puts the default back, so no future email points at a picture that is gone. */
    async removeLogo(id) {
      const row = await db.prepare(`SELECT object_key FROM ${T.logo} WHERE id = ?`).bind(String(id)).first();
      if (!row) throw new HubError('That logo is not there any more.', 404);
      const url = urlFor(row.object_key.slice('email-logos/'.length));
      const cur = await this.loadStyle();
      if (cur?.logoUrl === url) await this.saveStyle({ ...cur, logoUrl: null });
      if (images) await images.delete(row.object_key).catch(() => {});
      await db.prepare(`DELETE FROM ${T.logo} WHERE id = ?`).bind(String(id)).run();
    },
    /* PUBLIC. The host serves `GET <publicLogoBase><file>` with this, before any sign-in. */
    async serveLogo(file) {
      if (!LOGO_FILE.test(String(file)) || !images) return new Response('not found', { status: 404 });
      const obj = await images.get(`email-logos/${file}`);
      if (!obj) return new Response('not found', { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');   // the name is a uuid: a file never changes under it
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { headers });
    },

    /* ---- sent emails carried over from a provider that is gone or replaced (read-only history) */
    async listArchive() {
      const { results } = await db.prepare(
        `SELECT source, source_id AS id, title, subject, preview_text AS previewText, sent_at AS sentAt, audience, segment_text AS segmentText, emails_sent AS emailsSent,
                unique_opens AS uniqueOpens, clicks, open_rate AS openRate, click_rate AS clickRate, archive_url AS archiveUrl, LENGTH(html) AS bytes
           FROM ${T.archive} ORDER BY sent_at DESC`).all();
      return results || [];
    },
    async archivedHtml(source, id) {
      const row = await db.prepare(`SELECT html FROM ${T.archive} WHERE source = ? AND source_id = ?`).bind(String(source), String(id)).first();
      return row ? { html: row.html || '' } : null;
    },
    /* For a host's one-time importer: an idempotent upsert, so running it twice never duplicates. */
    async saveArchived(r) {
      await db.prepare(
        `INSERT INTO ${T.archive} (source, source_id, title, subject, preview_text, sent_at, audience, segment_text, emails_sent, unique_opens, clicks, open_rate, click_rate, archive_url, html)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_id) DO UPDATE SET title=excluded.title, subject=excluded.subject, preview_text=excluded.preview_text, sent_at=excluded.sent_at,
           audience=excluded.audience, segment_text=excluded.segment_text, emails_sent=excluded.emails_sent, unique_opens=excluded.unique_opens, clicks=excluded.clicks,
           open_rate=excluded.open_rate, click_rate=excluded.click_rate, archive_url=excluded.archive_url, html=excluded.html`,
      ).bind(r.source, r.id, r.title ?? null, r.subject ?? null, r.previewText ?? null, r.sentAt ? toSqlTime(Date.parse(r.sentAt)) : null, r.audience ?? null, r.segmentText ?? null,
        num(r.emailsSent), num(r.uniqueOpens), num(r.clicks), num(r.openRate), num(r.clickRate), r.archiveUrl ?? null, String(r.html || '').slice(0, 900_000)).run();
    }
  };
}
