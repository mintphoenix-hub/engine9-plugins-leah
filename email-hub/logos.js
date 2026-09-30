/* Logo uploads: what a file really is, and where it may be served from. Pure. */

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const LOGO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

/* What a file really is, from its first bytes. A name or a declared type is whatever the sender says. */
export function sniffImage(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/* A display name from a file name: extension off, odd characters to spaces, 60 characters at most. */
export const cleanLogoName = (v, fallback) => String(v || fallback || 'Logo').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\p{L}\p{N} _().\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Logo';
