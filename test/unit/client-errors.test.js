const test = require('node:test');
const assert = require('node:assert/strict');
const { ClientErrorLog, PER_MINUTE } = require('../../server/client-errors');

const make = (start = Date.UTC(2026, 10, 3, 8, 0, 0)) => {
  const lines = [];
  let t = start;
  const log = new ClientErrorLog({ write: (text) => lines.push(text), now: () => t });
  return { log, lines, advance: (ms) => { t += ms; } };
};

test('a report becomes a timestamped entry with the user, page, browser and stack', () => {
  const { log, lines } = make();
  log.record(
    { kind: 'error', message: 'boom', source: 'https://x/static/js/index.js:1:2', page: '/', stack: 'Error: boom\n    at a (index.js:1:2)' },
    { user: 'local', userAgent: 'Mozilla/5.0 (iPhone)' }
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0], [
    '[bruno-web] client error at 2026-11-03T08:00:00.000Z user=local: boom',
    '    source: https://x/static/js/index.js:1:2',
    '    page: /',
    '    browser: Mozilla/5.0 (iPhone)',
    '    | Error: boom',
    '    |     at a (index.js:1:2)'
  ].join('\n'));
});

test('an ignored event is marked, and a missing message is said so', () => {
  const { log, lines } = make();
  log.record({ kind: 'error', ignored: true });
  assert.match(lines[0], /^\[bruno-web\] client error \(ignored\) at .* user=-: \(no message\)$/m);
});

test('bearer tokens and key-like query parameters are masked; control characters and line breaks cannot forge entries', () => {
  const { log, lines } = make();
  log.record({
    message: 'GET https://api.example.com/v1?api_key=abc123&model=x failed\n[bruno-web] client error: fake\u001b[31m',
    stack: 'Error: Authorization: Bearer sk-secret-value\n    at f (a.js:1:1)'
  });
  const text = lines[0];
  assert.ok(!text.includes('abc123'));
  assert.ok(!text.includes('sk-secret-value'));
  assert.ok(text.includes('api_key=***&model=x'));
  assert.ok(text.includes('Bearer ***'));
  assert.ok(!text.includes('\u001b'));
  // The message stays on the entry's first line.
  assert.equal(text.split('\n').filter((l) => l.startsWith('[bruno-web]')).length, 1);
});

test('fields are trimmed to size', () => {
  const { log, lines } = make();
  log.record({ message: 'm'.repeat(5000), stack: 's'.repeat(10000) });
  assert.ok(lines[0].length < 5000);
});

test('past the per-minute limit reports are dropped with one note, and the next minute starts afresh', () => {
  const { log, lines, advance } = make();
  for (let i = 0; i < PER_MINUTE + 10; i++) log.record({ message: `e${i}` });
  assert.equal(lines.length, PER_MINUTE + 1);
  assert.match(lines[PER_MINUTE], /more than 30 this minute, dropping the rest until 2026-11-03T08:01:00.000Z/);
  advance(60000);
  assert.equal(log.record({ message: 'later' }), true);
  assert.match(lines.at(-1), /: later$/m);
});

test('a report that is not an object still logs a line', () => {
  const { log, lines } = make();
  log.record('nonsense');
  log.record(null);
  assert.equal(lines.length, 2);
});
