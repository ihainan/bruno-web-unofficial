const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bw-policy-')));
const root = path.join(base, 'workspace');
fs.mkdirSync(path.join(root, 'a'), { recursive: true });
fs.mkdirSync(path.join(base, 'outside'));
fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'escape'));
process.env.BRUNO_WEB_DATA = base;
process.env.BRUNO_WEB_ROOTS = root;
process.env.BRUNO_WEB_SECRET_TEST = 'x';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Policy, isInside } = require('../../server/policy');

test('our settings are removed from the environment scripts can read', () => {
  assert.equal(process.env.BRUNO_WEB_SECRET_TEST, undefined);
  assert.equal(process.env.BRUNO_WEB_ROOTS, undefined);
});

test('isInside handles the filesystem root', () => {
  assert.ok(isInside('/', '/tmp/x'));
  assert.ok(isInside('/data', '/data'));
  assert.ok(isInside('/data', '/data/a/b'));
  assert.ok(!isInside('/data', '/database'));
  assert.ok(!isInside('/data', '/'));
});

test('dialog paths must stay inside the roots after resolving symlinks', async () => {
  const policy = new Policy();
  assert.equal(await policy.resolveInsideRoots(path.join(root, 'a')), path.join(root, 'a'));
  await assert.rejects(policy.resolveInsideRoots(path.join(root, 'escape')), /outside/);
  await assert.rejects(policy.resolveInsideRoots(path.join(root, '..', 'outside')), /outside/);
  await assert.rejects(policy.resolveInsideRoots('relative/path'), /Invalid path/);
  await assert.rejects(policy.resolveInsideRoots(path.join(root, 'missing')), /does not exist/);
});

test('a save path may not exist yet, but its existing parent must be inside', async () => {
  const policy = new Policy();
  assert.equal(await policy.resolveInsideRoots(path.join(root, 'a', 'new', 'file.zip'), { forWrite: true }), path.join(root, 'a', 'new', 'file.zip'));
  await assert.rejects(policy.resolveInsideRoots(path.join(root, 'escape', 'file.zip'), { forWrite: true }), /outside/);
});

test('terminal and npm install are refused by default', () => {
  const policy = new Policy();
  assert.match(policy.checkChannel('terminal:create'), /terminal is disabled/);
  assert.match(policy.checkChannel('renderer:install-postman-packages'), /npm packages/);
  assert.equal(policy.checkChannel('renderer:save-request'), null);
});
