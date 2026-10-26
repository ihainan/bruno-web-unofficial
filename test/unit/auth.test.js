process.env.BRUNO_WEB_AUTH = 'password';
process.env.BRUNO_WEB_PASSWORD = 'correct horse';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Keep the sessions file out of the repository's data directory.
process.env.BRUNO_WEB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-web-auth-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../server/config');
const { Auth, scryptHash, verifyPassword } = require('../../server/auth');

const req = (headers = {}) => ({ headers, socket: { remoteAddress: '10.0.0.1' }, secure: false });

test('password hashes verify', () => {
  const h = scryptHash('s3cret');
  assert.ok(verifyPassword('s3cret', h));
  assert.ok(!verifyPassword('wrong', h));
});

test('login issues a session cookie that authenticates later requests', () => {
  const auth = new Auth();
  const result = auth.login(req(), 'correct horse');
  assert.ok(result.ok);
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /SameSite=Strict/);
  const token = /bruno_web_session=([^;]+)/.exec(result.cookie)[1];
  assert.equal(auth.userFor(req({ cookie: `bruno_web_session=${token}` })), 'admin');
  assert.equal(auth.userFor(req({ cookie: 'bruno_web_session=forged' })), null);
});

test('repeated wrong passwords are throttled', () => {
  const auth = new Auth();
  for (let i = 0; i < 10; i++) assert.equal(auth.login(req(), 'nope').status, 401);
  assert.equal(auth.login(req(), 'correct horse').status, 429);
});

test('WebSocket and API writes must come from our own origin', () => {
  const auth = new Auth();
  assert.ok(auth.isSameOrigin(req({ origin: 'http://bruno.example:8484', host: 'bruno.example:8484' })));
  assert.ok(!auth.isSameOrigin(req({ origin: 'http://evil.example', host: 'bruno.example:8484' })));
  assert.ok(!auth.isSameOrigin(req({ origin: 'null', host: 'bruno.example:8484' })));
  assert.ok(!auth.isSameOrigin(req({ host: 'bruno.example:8484' })));
});

test('a malformed cookie is ignored instead of throwing', () => {
  const auth = new Auth();
  assert.equal(auth.userFor(req({ cookie: 'bruno_web_session=%' })), null);
});

test('a malformed password hash never matches', () => {
  assert.equal(verifyPassword('anything', 'scrypt$aa$zz'), false);
  assert.equal(verifyPassword('anything', 'scrypt$$'), false);
});

test('the same host on another scheme is not the same origin', () => {
  const auth = new Auth();
  const r = { headers: { origin: 'https://bruno.example:8484', host: 'bruno.example:8484' }, socket: { remoteAddress: 'x' } };
  assert.ok(!auth.isSameOrigin(r));
  assert.ok(!auth.isSameOrigin({ headers: { origin: 'file://bruno.example:8484', host: 'bruno.example:8484' }, socket: {} }));
});

test('a login survives a restart, but not a password change or a logout', () => {
  const sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-web-auth-')), 'sessions.json');
  const result = new Auth({ sessionsFile }).login(req(), 'correct horse');
  const token = /bruno_web_session=([^;]+)/.exec(result.cookie)[1];
  const cookie = `bruno_web_session=${token}`;

  assert.ok(!fs.readFileSync(sessionsFile, 'utf8').includes(token), 'the file must not hold the token itself');
  assert.equal(fs.statSync(sessionsFile).mode & 0o777, 0o600);

  const restarted = new Auth({ sessionsFile });
  assert.equal(restarted.userFor(req({ cookie })), 'admin');

  const saved = config.password;
  config.password = 'new password';
  try {
    assert.equal(new Auth({ sessionsFile }).userFor(req({ cookie })), null);
  } finally {
    config.password = saved;
  }

  restarted.logout(req({ cookie }));
  assert.equal(new Auth({ sessionsFile }).userFor(req({ cookie })), null);
});

test('an unreadable sessions file starts with no sessions instead of failing', () => {
  const sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-web-auth-')), 'sessions.json');
  for (const bad of ['{not json', '{"salt":"00112233445566778899aabbccddeeff","mac":{"toString":null},"data":"{}"}', 'null']) {
    fs.writeFileSync(sessionsFile, bad);
    const auth = new Auth({ sessionsFile });
    assert.equal(auth.sessions.size, 0);
    assert.ok(auth.login(req(), 'correct horse').ok);
  }
});

test('a session added to the file by hand is rejected', () => {
  const sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-web-auth-')), 'sessions.json');
  new Auth({ sessionsFile }).login(req(), 'correct horse');
  const saved = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  const data = JSON.parse(saved.data);
  const forgedId = require('node:crypto').createHash('sha256').update('chosen').digest('base64url');
  data[forgedId] = { user: 'admin', expiresAt: Date.now() + 3600e3, cookieIssuedAt: 0 };
  fs.writeFileSync(sessionsFile, JSON.stringify({ ...saved, data: JSON.stringify(data) }));
  assert.equal(new Auth({ sessionsFile }).userFor(req({ cookie: 'bruno_web_session=chosen' })), null);
});

test('a logout that cannot be written removes the saved sessions instead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-web-auth-'));
  const sessionsFile = path.join(dir, 'sessions.json');
  const auth = new Auth({ sessionsFile });
  const token = /bruno_web_session=([^;]+)/.exec(auth.login(req(), 'correct horse').cookie)[1];
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = () => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };
  try {
    auth.logout(req({ cookie: `bruno_web_session=${token}` }));
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(new Auth({ sessionsFile }).userFor(req({ cookie: `bruno_web_session=${token}` })), null);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('in a read-only directory a logout empties the saved file instead', () => {
  const sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-web-auth-')), 'sessions.json');
  const auth = new Auth({ sessionsFile });
  const token = /bruno_web_session=([^;]+)/.exec(auth.login(req(), 'correct horse').cookie)[1];
  const real = { writeFileSync: fs.writeFileSync, rmSync: fs.rmSync };
  const readOnly = () => {
    throw Object.assign(new Error('read-only'), { code: 'EACCES' });
  };
  fs.writeFileSync = readOnly;
  fs.rmSync = readOnly;
  try {
    auth.logout(req({ cookie: `bruno_web_session=${token}` }));
  } finally {
    Object.assign(fs, real);
  }
  assert.equal(new Auth({ sessionsFile }).userFor(req({ cookie: `bruno_web_session=${token}` })), null);
});
