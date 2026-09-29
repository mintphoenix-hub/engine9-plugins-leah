/* Web Push: RFC 8291 encryption and RFC 8292 VAPID. What would be wrong silently is an encryption
   slip: the push service accepts the message and the phone drops it. So the receiver side below is
   written independently of webpush.js and decrypts exactly as a browser does. */
import { b64u, generateVapidKeys, pushEnabled, validSubscription, vapidAuthorization, encryptPayload, sendPush } from './webpush.js';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? ' -> ' + d : ''}`); c ? pass++ : fail++; };
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

/* A browser's push keys, as PushManager.subscribe would make them. */
async function fakeBrowser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { ua, pub, auth, sub: { endpoint, keys: { p256dh: b64u.encode(pub), auth: b64u.encode(auth) } } };
}

/* RFC 8291 from the receiving end. */
async function browserDecrypts({ ua, pub, auth }, body) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const H = async (s, ikm, info, bits) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info },
    await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bits));
  const ikm = await H(auth, ecdh, new Uint8Array([...te.encode('WebPush: info\0'), ...pub, ...asPub]), 256);
  const cek = await H(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await H(salt, ikm, te.encode('Content-Encoding: nonce\0'), 96);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
  return { rs, idlen, delimiter: plain[plain.length - 1], text: new TextDecoder().decode(plain.slice(0, -1)) };
}

console.log('encryption (RFC 8291):');
{
  const b = await fakeBrowser();
  const body = await encryptPayload(b.sub, JSON.stringify({ title: 'Ada replied', body: 'see you at tech' }));
  const out = await browserDecrypts(b, body);
  ck('a browser can decrypt what is sent', JSON.parse(out.text).body === 'see you at tech');
  ck('record size 4096, sender key inline, last-record delimiter', out.rs === 4096 && out.idlen === 65 && out.delimiter === 2);
  const again = await encryptPayload(b.sub, 'same');
  ck('every message has its own salt and key', b64u.encode(again.slice(0, 37)) !== b64u.encode(body.slice(0, 37)));
  let threw = false; try { await encryptPayload(b.sub, 'x'.repeat(5000)); } catch { threw = true; }
  ck('an oversized payload is refused, not truncated', threw);
  const flat = await encryptPayload({ p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth }, 'flat row');
  ck('a stored flat row works as well as the browser JSON', (await browserDecrypts(b, flat)).text === 'flat row');
}

console.log('\nVAPID (RFC 8292):');
{
  const keys = await generateVapidKeys();
  const vapid = { ...keys, subject: 'mailto:ops@example.test' };
  ck('generated keys are the right length', b64u.decode(keys.publicKey).length === 65 && b64u.decode(keys.privateKey).length === 32);
  ck('a second pair is different', (await generateVapidKeys()).publicKey !== keys.publicKey);
  const header = await vapidAuthorization(vapid, 'https://fcm.googleapis.com/fcm/send/abc', Date.UTC(2026, 8, 29));
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) || [];
  const [h, c, s] = String(jwt).split('.');
  const claims = JSON.parse(new TextDecoder().decode(b64u.decode(c)));
  const pub = b64u.decode(keys.publicKey);
  const verifyKey = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)) }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  ck('the JWT verifies with the public key', await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, b64u.decode(s), te.encode(`${h}.${c}`)));
  ck('aud is the push service origin, exp within 24h, sub is the subject', claims.aud === 'https://fcm.googleapis.com'
    && claims.exp - Date.UTC(2026, 8, 29) / 1000 <= 24 * 3600 && claims.sub === 'mailto:ops@example.test');
  ck('k is the public key', k === keys.publicKey);
  let noSubject = false; try { await vapidAuthorization({ ...keys }, 'https://fcm.googleapis.com/x'); } catch { noSubject = true; }
  ck('no subject is refused (Apple rejects it)', noSubject);
  ck('push is on only with a full key set', pushEnabled(vapid) && !pushEnabled({ publicKey: 'x' }) && !pushEnabled({ ...vapid, privateKey: '' }) && !pushEnabled(null));
}

console.log('\nsubscriptions:');
{
  const b = await fakeBrowser();
  const ok = validSubscription(b.sub);
  ck('a push service endpoint is accepted and flattened', ok && ok.endpoint === b.sub.endpoint && ok.p256dh === b.sub.keys.p256dh && ok.auth === b.sub.keys.auth);
  ck('an already-flat row is accepted too', !!validSubscription({ endpoint: b.sub.endpoint, p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth }));
  ck('an endpoint anywhere else is refused', !validSubscription({ ...b.sub, endpoint: 'https://evil.example/fcm' }));
  ck('plain http is refused', !validSubscription({ ...b.sub, endpoint: 'http://fcm.googleapis.com/x' }));
  ck('a lookalike host is refused', !validSubscription({ ...b.sub, endpoint: 'https://fcm.googleapis.com.evil.example/x' }));
  ck('keys of the wrong length are refused', !validSubscription({ ...b.sub, keys: { p256dh: 'AAAA', auth: b.sub.keys.auth } }));
  ck('nothing is refused, not thrown', validSubscription(null) === null && validSubscription('x') === null && validSubscription({}) === null);
  ck('Apple, Mozilla and Windows are accepted', ['https://web.push.apple.com/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://x.notify.windows.com/w'].every((endpoint) => !!validSubscription({ ...b.sub, endpoint })));
  ck('a host can supply its own allow-list', !!validSubscription({ ...b.sub, endpoint: 'https://push.example.test/x' }, { hosts: [/^push\.example\.test$/] }));
}

console.log('\nsending:');
{
  const b = await fakeBrowser();
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:ops@example.test' };
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { status: 201 }; };
  const r = await sendPush(vapid, { endpoint: b.sub.endpoint, p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth }, { title: 'Hi', body: 'there' }, { fetchImpl, urgency: 'high' });
  ck('201 is ok, not gone', r.ok && !r.gone && r.status === 201);
  ck('it posts to the endpoint with the standard headers', seen.url === b.sub.endpoint && seen.init.method === 'POST'
    && seen.init.headers['Content-Encoding'] === 'aes128gcm' && seen.init.headers.Urgency === 'high' && seen.init.headers.TTL === '86400'
    && seen.init.headers.Authorization.startsWith('vapid t='));
  ck('and what it posts decrypts as the message', JSON.parse((await browserDecrypts(b, seen.init.body)).text).title === 'Hi');
  ck('404 and 410 mean gone', (await sendPush(vapid, b.sub, 'x', { fetchImpl: async () => ({ status: 410 }) })).gone
    && (await sendPush(vapid, b.sub, 'x', { fetchImpl: async () => ({ status: 404 }) })).gone);
  ck('a 500 is a failure but not gone', await (async () => { const x = await sendPush(vapid, b.sub, 'x', { fetchImpl: async () => ({ status: 500 }) }); return !x.ok && !x.gone; })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
