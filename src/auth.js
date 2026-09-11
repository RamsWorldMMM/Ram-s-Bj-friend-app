// Username/password auth for a small, fixed set of personal accounts.
// PBKDF2-SHA256 for storage; HMAC-SHA256 signed token in an HttpOnly cookie.

const enc = new TextEncoder();

// Cloudflare Workers' Web Crypto refuses PBKDF2 above 100,000 iterations:
//   "Pbkdf2 failed: iteration counts above 100000 are not supported".
// It is the platform ceiling, not a tuning choice — 210,000 deployed fine and
// then failed every login at runtime. Existing rows keep their own stored
// `iterations`, so old accounts still verify; only new hashes use this.
export const PBKDF2_ITERATIONS = 100_000;
const COOKIE_NAME = 'bjf_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// --- encoding helpers -------------------------------------------------------

function bytesToB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time comparison so token/password checks leak no timing signal. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- password hashing -------------------------------------------------------

export async function hashPassword(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return { hash: bytesToB64(bits), salt: bytesToB64(salt), iterations };
}

export async function verifyPassword(password, user) {
  const { hash } = await hashPassword(password, user.password_salt, user.iterations);
  return timingSafeEqual(hash, user.password_hash);
}

// --- signed session tokens --------------------------------------------------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

async function sign(payload, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return b64url(sig);
}

export async function issueToken(userId, secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${userId}.${exp}`;
  return `${payload}.${await sign(payload, secret)}`;
}

/** Returns the userId, or null if the token is malformed, forged, or expired. */
export async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const expected = await sign(`${userId}.${exp}`, secret);
  if (!timingSafeEqual(sig, expected)) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return userId;
}

// --- cookie plumbing --------------------------------------------------------

export function sessionCookie(token, { secure = true } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',            // blocks cross-site POSTs, so no CSRF token needed
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie({ secure = true } = {}) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function readCookie(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

/** Resolves the authenticated user for a request, or null. */
export async function authenticate(request, env) {
  const userId = await verifyToken(readCookie(request), env.AUTH_SECRET);
  if (!userId) return null;
  return env.DB.prepare('SELECT id, username FROM users WHERE id = ?').bind(userId).first();
}
