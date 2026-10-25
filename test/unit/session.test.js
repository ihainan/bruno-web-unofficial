process.env.BRUNO_WEB_DATA = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bw-unit-'));
process.env.BRUNO_WEB_REPLAY_MAX_EVENTS = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { encode, decode } = require('../../web/codec');
const { Hub } = require('../../server/session');

class FakeIpcMain extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  handle(ch, fn) { this.handlers.set(ch, fn); }
  getHandler(ch) { return this.handlers.get(ch); }
}

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.closed = null; }
  send(text) { this.sent.push(decode(text)); }
  close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
  deliver(msg) { this.emit('message', Buffer.from(encode(msg))); }
  drop() { this.readyState = 3; this.emit('close'); }
}

const makeHub = () => {
  const ipcMain = new FakeIpcMain();
  const webContents = new EventEmitter();
  const hub = new Hub({
    ipcMain,
    mainWindow: { webContents },
    policy: { checkChannel: () => null, roots: () => ['/'], resolveInsideRoots: async (p) => p, onTheme() {}, oauthCallbackUrl: () => null },
    downloads: { register: () => 'token' }
  });
  return { hub, ipcMain, webContents };
};

const tick = () => new Promise((r) => setImmediate(r));

test('invoke runs the handler and returns its value with a sequence number', async () => {
  const { hub, ipcMain } = makeHub();
  ipcMain.handle('renderer:add', (event, a, b) => a + b);
  const ws = new FakeWs();
  hub.attach(ws, { pageId: 'p1', lastSeq: 0 });
  ws.deliver({ t: 'invoke', id: 1, ch: 'renderer:add', args: [2, 3] });
  await tick();
  const result = ws.sent.find((m) => m.t === 'result');
  assert.equal(result.ok, true);
  assert.equal(result.value, 5);
  assert.ok(result.seq > 0);
});

test('a rejected invoke carries the Electron error text', async () => {
  const { hub, ipcMain } = makeHub();
  ipcMain.handle('renderer:fail', () => { throw new Error('nope'); });
  const ws = new FakeWs();
  hub.attach(ws, { pageId: 'p1', lastSeq: 0 });
  ws.deliver({ t: 'invoke', id: 1, ch: 'renderer:fail', args: [] });
  ws.deliver({ t: 'invoke', id: 2, ch: 'renderer:missing', args: [] });
  await tick();
  const [a, b] = ws.sent.filter((m) => m.t === 'result');
  assert.equal(a.error.message, "Error invoking remote method 'renderer:fail': Error: nope");
  assert.equal(b.error.message, "Error invoking remote method 'renderer:missing': Error: No handler registered for 'renderer:missing'");
});

test('a resent message the server already received runs only once', async () => {
  const { hub, ipcMain } = makeHub();
  let calls = 0;
  ipcMain.handle('renderer:create', () => ++calls);
  const ws = new FakeWs();
  hub.attach(ws, { pageId: 'p1', lastSeq: 0 });
  ws.deliver({ t: 'invoke', id: 1, ch: 'renderer:create', args: [] });
  ws.deliver({ t: 'invoke', id: 1, ch: 'renderer:create', args: [] });
  await tick();
  assert.equal(calls, 1);
});

test('reconnecting with the same page replays missed messages and reports what was received', async () => {
  const { hub, ipcMain } = makeHub();
  ipcMain.handle('renderer:slow', () => 'done');
  const ws1 = new FakeWs();
  hub.attach(ws1, { pageId: 'p1', lastSeq: 0 });
  ws1.deliver({ t: 'invoke', id: 1, ch: 'renderer:slow', args: [] });
  await tick();
  const seenSeq = Math.max(...ws1.sent.filter((m) => m.seq).map((m) => m.seq));
  ws1.drop();
  hub.pushEvent('main:while-away', [42]);

  const ws2 = new FakeWs();
  hub.attach(ws2, { pageId: 'p1', lastSeq: seenSeq });
  assert.deepEqual(ws2.sent[0], { t: 'hello', resumed: true, rx: 1 });
  const replayed = ws2.sent.slice(1);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].ch, 'main:while-away');
  assert.deepEqual(replayed[0].args, [42]);
});

test('an unknown page id starts a new page', () => {
  const { hub } = makeHub();
  const ws1 = new FakeWs();
  hub.attach(ws1, { pageId: 'p1', lastSeq: 0 });
  const ws2 = new FakeWs();
  hub.attach(ws2, { pageId: 'p2', lastSeq: 0 });
  assert.equal(ws2.sent[0].resumed, false);
  assert.equal(ws1.sent.at(-1).t, 'taken-over');
  assert.equal(ws1.closed, 4001);
});

test('messages from a socket that was taken over are ignored', async () => {
  const { hub, ipcMain } = makeHub();
  let calls = 0;
  ipcMain.handle('renderer:x', () => ++calls);
  const ws1 = new FakeWs();
  hub.attach(ws1, { pageId: 'p1', lastSeq: 0 });
  const ws2 = new FakeWs();
  hub.attach(ws2, { pageId: 'p2', lastSeq: 0 });
  ws1.emit('message', Buffer.from(encode({ t: 'invoke', id: 1, ch: 'renderer:x', args: [] })));
  await tick();
  assert.equal(calls, 0);
});

test('after the replay buffer overflowed the page cannot resume', () => {
  const { hub } = makeHub();
  const ws1 = new FakeWs();
  hub.attach(ws1, { pageId: 'p1', lastSeq: 0 });
  ws1.drop();
  for (let i = 0; i < 10; i++) hub.pushEvent('main:spam', [i]);
  const ws2 = new FakeWs();
  hub.attach(ws2, { pageId: 'p1', lastSeq: 0 });
  assert.equal(ws2.sent[0].resumed, false);
});

test('acknowledged messages leave the replay buffer', () => {
  const { hub } = makeHub();
  const ws = new FakeWs();
  hub.attach(ws, { pageId: 'p1', lastSeq: 0 });
  hub.pushEvent('main:a', []);
  hub.pushEvent('main:b', []);
  ws.deliver({ t: 'ack', seq: hub.seq });
  assert.equal(hub.buffer.length, 0);
});

test('did-finish-load fires once, when the page reports its load event', () => {
  const { hub, webContents } = makeHub();
  let fired = 0;
  webContents.on('did-finish-load', () => fired++);
  const ws = new FakeWs();
  hub.attach(ws, { pageId: 'p1', lastSeq: 0 });
  assert.equal(fired, 0);
  ws.deliver({ t: 'page-loaded', id: 1 });
  ws.deliver({ t: 'page-loaded', id: 2 });
  assert.equal(fired, 1);
});

test('a file dialog is answered by the page, and cancelled when a new page takes over', async () => {
  const { hub } = makeHub();
  const ws1 = new FakeWs();
  hub.attach(ws1, { pageId: 'p1', lastSeq: 0 });
  const first = hub.openDialog({ properties: ['openDirectory'] });
  const rpc = ws1.sent.find((m) => m.t === 'rpc');
  assert.equal(rpc.method, 'dialog-open');
  ws1.deliver({ t: 'rpc-result', id: 1, rpc: rpc.id, ok: true, value: { canceled: false, filePaths: ['/data/x'] } });
  assert.deepEqual(await first, { canceled: false, filePaths: ['/data/x'] });

  const second = hub.openDialog({});
  hub.attach(new FakeWs(), { pageId: 'p2', lastSeq: 0 });
  assert.deepEqual(await second, { canceled: true, filePaths: [] });
});

test('a result computed for a replaced page does not reach the new page', async () => {
  const { hub, ipcMain } = makeHub();
  let release;
  ipcMain.handle('renderer:slow', () => new Promise((r) => { release = r; }));
  const ws1 = new FakeWs();
  hub.attach(ws1, { pageId: 'p1', lastSeq: 0 });
  ws1.deliver({ t: 'invoke', id: 1, ch: 'renderer:slow', args: [] });
  await tick();
  const ws2 = new FakeWs();
  hub.attach(ws2, { pageId: 'p2', lastSeq: 0 });
  release('old page result');
  await tick();
  assert.equal(ws2.sent.filter((m) => m.t === 'result').length, 0);
});

test('malformed messages are ignored and a numbering gap forces a reconnect', async () => {
  const { hub, ipcMain } = makeHub();
  let calls = 0;
  ipcMain.handle('renderer:x', () => ++calls);
  const ws = new FakeWs();
  hub.attach(ws, { pageId: 'p1', lastSeq: 0 });
  ws.emit('message', Buffer.from('null'));
  ws.emit('message', Buffer.from('42'));
  ws.deliver({ t: 'invoke', id: 2, ch: 'renderer:x', args: [] });
  await tick();
  assert.equal(calls, 0);
  assert.equal(ws.closed, 4002);
});

test('a page can resume after an overflow it had already received', () => {
  const { hub } = makeHub();
  const ws1 = new FakeWs();
  hub.attach(ws1, { pageId: 'p1', lastSeq: 0 });
  for (let i = 0; i < 10; i++) hub.pushEvent('main:burst', [i]);
  const seen = hub.seq;
  ws1.deliver({ t: 'ack', seq: seen });
  ws1.drop();
  const ws2 = new FakeWs();
  hub.attach(ws2, { pageId: 'p1', lastSeq: seen });
  assert.equal(ws2.sent[0].resumed, true);
});
