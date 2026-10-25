const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, decode, formatInvokeError } = require('../../web/codec');

const roundTrip = (v) => decode(encode({ v })).v;

test('binary values come back as Uint8Array', () => {
  const out = roundTrip({ buf: Buffer.from('héllo'), u8: new Uint8Array([1, 2, 255]) });
  assert.ok(out.buf instanceof Uint8Array);
  assert.equal(Buffer.from(out.buf).toString(), 'héllo');
  assert.deepEqual([...out.u8], [1, 2, 255]);
});

test('Date, Map, Set, BigInt and non-finite numbers survive', () => {
  const d = new Date('2026-10-25T01:02:03Z');
  const out = roundTrip({ d, m: new Map([['a', new Date(0)]]), s: new Set([1, 2]), b: 10n, n: [NaN, Infinity, -Infinity] });
  assert.equal(out.d.getTime(), d.getTime());
  assert.ok(out.m.get('a') instanceof Date);
  assert.deepEqual([...out.s], [1, 2]);
  assert.equal(out.b, 10n);
  assert.ok(Number.isNaN(out.n[0]));
  assert.equal(out.n[1], Infinity);
  assert.equal(out.n[2], -Infinity);
});

test('undefined is kept in arrays and as an object property, like structured clone', () => {
  const out = roundTrip({ arr: [1, undefined, 3], obj: { a: undefined, b: 1 } });
  assert.equal(out.arr.length, 3);
  assert.equal(out.arr[1], undefined);
  assert.ok('a' in out.obj);
  assert.equal(out.obj.a, undefined);
});

test('a user object that uses the tag key is not mistaken for a tagged value', () => {
  const out = roundTrip({ __bw$: 'u8', v: 'not base64' });
  assert.deepEqual(out, { __bw$: 'u8', v: 'not base64' });
});

test('errors keep name and message', () => {
  const err = new TypeError('boom');
  const out = roundTrip(err);
  assert.ok(out instanceof Error);
  assert.equal(out.name, 'TypeError');
  assert.equal(out.message, 'boom');
});

test('invoke error text matches Electron, which the renderer parses', () => {
  const msg = formatInvokeError('send-http-request', String(new Error('Request cancelled')));
  assert.equal(msg, "Error invoking remote method 'send-http-request': Error: Request cancelled");
  // utils/common/error.js in bruno-app strips exactly this prefix.
  assert.equal(msg.replace(/^Error invoking remote method '.+?': (Error: )?/, ''), 'Request cancelled');
});

test('undefined survives as a Map key or value, a Set member and under an empty-string key', () => {
  const out = roundTrip({ m: new Map([[undefined, 1], ['k', undefined]]), s: new Set([undefined, 2]), e: { '': undefined } });
  assert.ok(out.m.has(undefined));
  assert.equal(out.m.get(undefined), 1);
  assert.ok(out.m.has('k'));
  assert.equal(out.m.get('k'), undefined);
  assert.ok(out.s.has(undefined));
  assert.ok('' in out.e);
});

test('messages without tagged values take the plain JSON path and still decode', () => {
  const text = encode({ t: 'event', ch: 'main:x', args: [{ a: 1, b: 'two' }] });
  assert.ok(!text.includes('__bw$'));
  assert.deepEqual(decode(text).args, [{ a: 1, b: 'two' }]);
});
