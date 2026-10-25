process.env.BRUNO_WEB_AUTH = 'password';
process.env.BRUNO_WEB_PASSWORD = 'correct horse';
const test = require('node:test');
const assert = require('node:assert/strict');
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
