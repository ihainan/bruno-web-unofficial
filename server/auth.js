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
const fs = require('node:fs');
const path = require('node:path');
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

const tokenId = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

const isLoopback = (host) => ['127.0.0.1', '::1', 'localhost'].includes(host);

class Auth {
  constructor({ sessionsFile = config.sessionsFile } = {}) {
    this.mode = config.auth;
    // sha256(token) -> { user, expiresAt, cookieIssuedAt }. Keyed by a hash so
    // the sessions file on disk holds nothing a browser could present.
    this.sessions = new Map();
    this.sessionsFile = sessionsFile;
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
      this.loadSessions();
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
    const session = this.sessions.get(tokenId(token));
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(tokenId(token));
      this.saveSoon();
      return null;
    }
    // Sliding expiry.
    session.expiresAt = Date.now() + config.sessionTtlMs;
    this.saveSoon();
    return session.user;
  }

  // Like userFor() but without extending the session (used by periodic checks).
  isValid(req) {
    if (this.mode !== 'password') return !!this.userFor(req);
    const session = this.sessionFor(req.headers);
    return !!session && session.expiresAt >= Date.now();
  }

  // Activity on an open socket keeps the login alive (throttled to once a minute).
  touch(headers) {
    if (this.mode !== 'password') return;
    const session = this.sessionFor(headers);
    if (!session || session.expiresAt < Date.now()) return;
    const next = Date.now() + config.sessionTtlMs;
    if (next - session.expiresAt > 60000) {
      session.expiresAt = next;
      this.saveSoon();
    }
  }

  sessionFor(headers) {
    const token = parseCookies(headers.cookie)[COOKIE];
    return token ? this.sessions.get(tokenId(token)) : undefined;
  }

  /*
   * Sessions survive restarts through a small JSON file. It is bound to the
   * configured password: changing the password drops every saved session.
   * With a plain BRUNO_WEB_PASSWORD the binding is an scrypt hash under the
   * file's own salt, so the file does not give the password away cheaply.
   */
  passwordBinding(salt) {
    const secret = config.passwordHash ? `hash:${config.passwordHash}` : `plain:${config.password}`;
    return crypto.scryptSync(secret, Buffer.from(salt, 'hex'), 32).toString('hex');
  }

  loadSessions() {
    this.fileSalt = crypto.randomBytes(16).toString('hex');
    if (!this.sessionsFile) return;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[bruno-web] ignoring unreadable ${this.sessionsFile}: ${e.message}`);
      return;
    }
    if (!saved || typeof saved.salt !== 'string' || !/^[0-9a-f]{32}$/.test(saved.salt)) return;
    if (!safeEqual(saved.binding, this.passwordBinding(saved.salt))) return; // password changed
    this.fileSalt = saved.salt;
    this.binding = saved.binding;
    const now = Date.now();
    for (const [id, s] of Object.entries(saved.sessions || {})) {
      if (s && typeof s.user === 'string' && Number(s.expiresAt) > now) {
        this.sessions.set(id, { user: s.user, expiresAt: Number(s.expiresAt), cookieIssuedAt: Number(s.cookieIssuedAt) || 0 });
      }
    }
  }

  // Sliding expiry changes on every request; write those at most every 30 s.
  // Logins and logouts are written at once.
  saveSoon() {
    if (!this.sessionsFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveSessions(), 30 * 1000);
    this.saveTimer.unref();
  }

  saveSessions() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.sessionsFile || this.mode !== 'password') return;
    if (!this.binding) this.binding = this.passwordBinding(this.fileSalt);
    const now = Date.now();
    const sessions = {};
    for (const [id, s] of this.sessions) {
      if (s.expiresAt > now) sessions[id] = s;
      else this.sessions.delete(id);
    }
    const tmp = `${this.sessionsFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ salt: this.fileSalt, binding: this.binding, sessions }), { mode: 0o600 });
      fs.renameSync(tmp, this.sessionsFile);
    } catch (e) {
      console.warn(`[bruno-web] could not save sessions: ${e.message}`);
    }
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
    this.sessions.set(tokenId(token), { user: 'admin', expiresAt: Date.now() + config.sessionTtlMs, cookieIssuedAt: Date.now() });
    this.saveSessions();
    return { ok: true, cookie: this.cookieHeader(req, token, Math.floor(config.sessionTtlMs / 1000)) };
  }

  // The browser forgets the cookie at its Max-Age even when activity has kept
  // the session alive on the server; hand out a fresh one now and then.
  refreshCookie(req) {
    if (this.mode !== 'password') return null;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = token && this.sessions.get(tokenId(token));
    if (!session || session.expiresAt < Date.now()) return null;
    if (session.cookieIssuedAt && Date.now() - session.cookieIssuedAt < 10 * 60 * 1000) return null;
    session.cookieIssuedAt = Date.now();
    this.saveSoon();
    return this.cookieHeader(req, token, Math.floor(config.sessionTtlMs / 1000));
  }

  logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token && this.sessions.delete(tokenId(token))) this.saveSessions();
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
