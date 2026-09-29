/*
  Web Push, with no third-party service: the standard, done in WebCrypto.

    RFC 8291  Message Encryption for Web Push (aes128gcm, RFC 8188 content coding)
    RFC 8292  VAPID: the sender signs a short JWT (ES256) so the push service knows who sends

  The browser's push service (Google's for Chrome and Android, Apple's for Safari and a Home Screen
  app on iPhone, Mozilla's for Firefox) holds the connection to the phone. The host POSTs one
  encrypted message per subscription to the endpoint the browser handed over; the service can
  deliver it but cannot read it.

  Pure and dependency-free: WebCrypto and `fetch` only, so it runs unchanged in a Worker, Node 18+
  and Deno. Nothing here reads the environment or a database. The host passes its VAPID keys in:

    vapid = { publicKey, privateKey, subject }
      publicKey   the 65-byte uncompressed P-256 point, base64url. The page needs it to subscribe,
                  so it is public by design.
      privateKey  the 32-byte private scalar, base64url. A secret; never in a repository.
      subject     a mailto: or https: URL the push services can reach if sending misbehaves.
                  Required: Apple rejects a token without one.

  `generateVapidKeys()` makes a pair. One message per subscription, never batched: an endpoint is
  somebody's device.
*/

const enc = new TextEncoder();

export const b64u = {
  encode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/* A new VAPID pair, as the base64url strings a host stores: the public key in configuration, the
   private key as a secret. */
export async function generateVapidKeys() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicKey: b64u.encode(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))),
    privateKey: (await crypto.subtle.exportKey('jwk', k.privateKey)).d
  };
}

/* No private key, no push: the same "no key, no send" switch hosts use for email. */
export function pushEnabled(vapid) {
  return Boolean(vapid && vapid.publicKey && vapid.privateKey && vapid.subject);
}

/* Only the browsers' own push services. The endpoint is a URL a signed-in person hands the host and
   the host then POSTs to, so without this list a subscribe route would be a way to make a server
   send requests anywhere. */
export const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/
];

/* What a browser's PushSubscription.toJSON() gives, checked and flattened for storage:
   { endpoint, p256dh, auth }, or null if it is not something safe to send to. `hosts` replaces the
   allow-list, for a host that must reach another push service. */
export function validSubscription(sub, { hosts = PUSH_HOSTS } = {}) {
  if (!sub || typeof sub !== 'object') return null;
  let url;
  try { url = new URL(String(sub.endpoint || '')); } catch { return null; }
  if (url.protocol !== 'https:' || !hosts.some((re) => re.test(url.hostname))) return null;
  const p256dh = String(sub.keys?.p256dh ?? sub.p256dh ?? '');
  const auth = String(sub.keys?.auth ?? sub.auth ?? '');
  try {
    if (b64u.decode(p256dh).length !== 65 || b64u.decode(auth).length !== 16) return null;
  } catch { return null; }
  return { endpoint: url.href, p256dh, auth };
}

/* The VAPID private key as a WebCrypto key. A JWK wants x and y as well as d, and both are in the
   public key: 0x04 || x (32) || y (32). */
async function signingKey(vapid) {
  const pub = b64u.decode(vapid.publicKey);
  return crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)),
    d: vapid.privateKey, ext: true
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/* RFC 8292 §2: aud is the push service's origin, exp at most 24h out. WebCrypto's ECDSA signature is
   already r||s, which is exactly what a JWS ES256 signature is. */
export async function vapidAuthorization(vapid, endpoint, now = Date.now()) {
  if (!vapid?.subject) throw new Error('vapid.subject is required (a mailto: or https: URL)');
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: vapid.subject
  })));
  const input = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(vapid), enc.encode(input));
  return `vapid t=${input}.${b64u.encode(sig)}, k=${vapid.publicKey}`;
}

async function hkdf(salt, ikm, info, bits) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

/* RFC 8291 §3.4 and RFC 8188 §2: one record, so the whole payload plus its 0x02 delimiter must fit in
   rs - 16. Push services cap payloads near 4 KB anyway; send a title, a line of text and a link.
   `fixed` exists for tests: a known salt and sender key pair. */
export async function encryptPayload(sub, payload, fixed = {}) {
  // A stored row is flat ({p256dh, auth}); the browser's own JSON nests them under `keys`.
  const uaPublic = b64u.decode(sub.p256dh || sub.keys?.p256dh);
  const authSecret = b64u.decode(sub.auth || sub.keys?.auth);
  const plaintext = typeof payload === 'string' ? enc.encode(payload) : payload;
  const rs = 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error('push payload too large');

  const asKeys = fixed.keyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 256);

  const salt = fixed.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 96);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/* Send one message. Answers {status, ok, gone}: `gone` is the push service saying this subscription
   no longer exists (404 or 410), the host's cue to delete it. */
export async function sendPush(vapid, sub, message, { ttl = 24 * 3600, urgency = 'normal', fetchImpl = fetch } = {}) {
  const body = await encryptPayload(sub, typeof message === 'string' ? message : JSON.stringify(message));
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(vapid, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency
    },
    body
  });
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}

export default { b64u, generateVapidKeys, pushEnabled, PUSH_HOSTS, validSubscription, vapidAuthorization, encryptPayload, sendPush };
