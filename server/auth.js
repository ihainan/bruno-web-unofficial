/**
 * Authentication for the HTTP routes and the WebSocket upgrade.
 *
 * Modes (BRUNO_WEB_AUTH):
 *   password  single shared password (BRUNO_WEB_PASSWORD or BRUNO_WEB_PASSWORD_HASH
 *             as `scrypt$<salt hex>$<hash hex>`); session cookie after login.
 *   proxy     a reverse proxy has authenticated the user and passes the user
 *             header plus a shared secret header.
 *   none      no login; only allowed when listening on loopback.
 */
const crypto = require('node:crypto');
const config = require('./config');

const COOKIE = 'bruno_web_session';

const scryptHash = (password, salt = crypto.randomBytes(16)) => {
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
};

const HASH_FORMAT = /^scrypt\$[0-9a-f]{16,}\$[0-9a-f]{64}$/i;

const verifyPassword = (password, stored) => {
  // Buffer.from(x, 'hex') silently yields an empty buffer for non-hex input,
  // and two empty buffers compare equal: reject anything not well-formed.
  if (!HASH_FORMAT.test(String(stored))) return false;
  const [, saltHex, hashHex] = String(stored).split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
};

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

const parseCookies = (header) => {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (e) {
      // Malformed escapes come from clients we do not control; ignore the cookie.
    }
  }
  return out;
};

const isLoopback = (host) => ['127.0.0.1', '::1', 'localhost'].includes(host);

class Auth {
  constructor() {
    this.mode = config.auth;
    this.sessions = new Map(); // token -> { user, expiresAt }
    this.failures = new Map(); // ip -> { count, resetAt }

    if (!['password', 'proxy', 'none'].includes(this.mode)) {
      throw new Error(`Unknown BRUNO_WEB_AUTH mode: ${this.mode}`);
    }
    if (this.mode === 'password') {
      if (config.passwordHash) {
        if (!HASH_FORMAT.test(config.passwordHash)) {
          throw new Error('BRUNO_WEB_PASSWORD_HASH must look like scrypt$<salt hex>$<64 hex digits>');
        }
        this.storedHash = config.passwordHash;
      } else if (config.password) {
        this.storedHash = scryptHash(config.password);
      } else {
        throw new Error('BRUNO_WEB_AUTH=password needs BRUNO_WEB_PASSWORD or BRUNO_WEB_PASSWORD_HASH');
      }
    }
    if (this.mode === 'proxy' && !config.proxySecret) {
      throw new Error('BRUNO_WEB_AUTH=proxy needs BRUNO_WEB_PROXY_SECRET so other clients cannot forge the user header');
    }
    if (this.mode === 'none' && !isLoopback(config.host)) {
      throw new Error('BRUNO_WEB_AUTH=none is only allowed when HOST is a loopback address');
    }
  }

  // Returns the user name for an authenticated request, otherwise null.
  userFor(req) {
    if (this.mode === 'none') {
      // Same reason as in isSameOrigin(): refuse other host names pointing at us.
      const hostname = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      return isLoopback(hostname) ? 'local' : null;
    }
    if (this.mode === 'proxy') {
      const secret = req.headers[config.proxySecretHeader];
      const user = req.headers[config.proxyUserHeader];
      if (secret && safeEqual(secret, config.proxySecret) && user) return String(user);
      return null;
    }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    // Sliding expiry.
    session.expiresAt = Date.now() + config.sessionTtlMs;
    return session.user;
  }

  // Like userFor() but without extending the session (used by periodic checks).
  isValid(req) {
    if (this.mode !== 'password') return !!this.userFor(req);
    const session = this.sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    return !!session && session.expiresAt >= Date.now();
  }

  // Activity on an open socket keeps the login alive (throttled to once a minute).
  touch(headers) {
    if (this.mode !== 'password') return;
    const session = this.sessions.get(parseCookies(headers.cookie)[COOKIE]);
    if (!session || session.expiresAt < Date.now()) return;
    const next = Date.now() + config.sessionTtlMs;
    if (next - session.expiresAt > 60000) session.expiresAt = next;
  }

  tooManyFailures(ip) {
    const entry = this.failures.get(ip);
    return entry && entry.resetAt > Date.now() && entry.count >= 10;
  }

  recordFailure(ip) {
    const now = Date.now();
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt < now) this.failures.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    else entry.count += 1;
  }

  login(req, password) {
    const ip = req.socket.remoteAddress;
    if (this.tooManyFailures(ip)) return { ok: false, status: 429, error: 'Too many attempts, try again in 15 minutes' };
    if (!verifyPassword(password || '', this.storedHash)) {
      this.recordFailure(ip);
      return { ok: false, status: 401, error: 'Wrong password' };
    }
    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { user: 'admin', expiresAt: Date.now() + config.sessionTtlMs, cookieIssuedAt: Date.now() });
    return { ok: true, cookie: this.cookieHeader(req, token, Math.floor(config.sessionTtlMs / 1000)) };
  }

  // The browser forgets the cookie at its Max-Age even when activity has kept
  // the session alive on the server; hand out a fresh one now and then.
  refreshCookie(req) {
    if (this.mode !== 'password') return null;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = token && this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) return null;
    if (session.cookieIssuedAt && Date.now() - session.cookieIssuedAt < 10 * 60 * 1000) return null;
    session.cookieIssuedAt = Date.now();
    return this.cookieHeader(req, token, Math.floor(config.sessionTtlMs / 1000));
  }

  logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) this.sessions.delete(token);
    return this.cookieHeader(req, '', 0);
  }

  cookieHeader(req, value, maxAge) {
    const secure = req.secure || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  /**
   * Browsers do not apply CORS to WebSocket upgrades, so a page on another site
   * could open our socket with the user's cookie. Only accept same-origin upgrades.
   */
  isSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return false;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch (e) {
      return false;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (config.publicUrl) return parsed.origin === new URL(config.publicUrl).origin;
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    const proto = (config.trustProxy && req.headers['x-forwarded-proto']) || (req.socket && req.socket.encrypted ? 'https' : 'http');
    if (parsed.host !== host || parsed.protocol !== `${String(proto).split(',')[0].trim()}:`) return false;
    // Without a login, a DNS-rebinding page could otherwise pass the same-origin
    // test under its own host name.
    if (this.mode === 'none' && !isLoopback(parsed.hostname.replace(/^\[|\]$/g, ''))) return false;
    return true;
  }
}

module.exports = { Auth, scryptHash, verifyPassword, parseCookies };
