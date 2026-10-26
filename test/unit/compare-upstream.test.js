const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'compare-upstream-results.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-compare-'));
const FILE = 'tests/demo/demo.spec.ts';

// A minimal Playwright JSON report: one file, one describe, tests given as
// [title, status, results] where results is the number of attempts.
const report = (name, tests) => {
  const specs = tests.map(([title, status, results = 1]) => ({
    title,
    file: FILE,
    tests: [{ projectName: 'default', status, annotations: [], results: Array.from({ length: results }, () => ({})) }]
  }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ suites: [{ title: FILE, file: FILE, specs: [], suites: [{ title: 'Demo', file: FILE, specs }] }] }));
  return file;
};

const compare = (...args) => {
  const out = path.join(dir, `summary-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--json', out], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, summary: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
};

const id = (title) => `${FILE} › Demo › ${title}`;

const run = report('run.json', [
  ['ok', 'expected'],
  ['retried', 'expected', 2],
  ['broken by the upgrade', 'unexpected'],
  ['racy everywhere', 'unexpected'],
  ['new in this version', 'unexpected'],
  ['stopped after racy', 'skipped']
]);

test('without a baseline every unexpected failure counts', () => {
  const { code, summary } = compare(run);
  assert.equal(code, 1);
  assert.equal(summary.passed, 1);
  assert.deepEqual(summary.flaky, [id('retried')]);
  assert.equal(summary.failed.length, 3);
  assert.deepEqual(summary.notRun, [id('stopped after racy')]);
  assert.deepEqual(summary.baseline, []);
});

test('failures the baseline shares are listed but do not fail the run', () => {
  const base = report('base-shared.json', [
    ['broken by the upgrade', 'expected'],
    ['racy everywhere', 'unexpected'],
    ['stopped after racy', 'skipped']
  ]);
  const { code, stdout, summary } = compare(run, '--baseline', base);
  assert.equal(code, 1, 'the test that passes on the baseline still fails the run');
  assert.deepEqual(summary.failed, [id('broken by the upgrade'), id('new in this version')]);
  assert.deepEqual(summary.baseline, [id('racy everywhere'), id('stopped after racy')]);
  assert.deepEqual(summary.notRun, []);
  assert.match(stdout, /fail on baseline too 2/);
  assert.match(stdout, /BASELINE tests\/demo\/demo\.spec\.ts › Demo › racy everywhere/);
});

test('the run passes when every remaining failure also fails on the baseline', () => {
  const only = report('run-racy.json', [['ok', 'expected'], ['racy everywhere', 'unexpected'], ['stopped after racy', 'skipped']]);
  const base = report('base-racy.json', [['racy everywhere', 'flaky', 2], ['stopped after racy', 'skipped']]);
  assert.equal(compare(only, '--baseline', base).code, 1, 'passing on the baseline after a retry is still passing');
  const base2 = report('base-racy2.json', [['racy everywhere', 'unexpected'], ['stopped after racy', 'skipped']]);
  const { code, summary } = compare(only, '--baseline', base2);
  assert.equal(code, 0);
  assert.equal(summary.baseline.length, 2);
});

test('a missing baseline file is bad input', () => {
  assert.equal(compare(run, '--baseline', path.join(dir, 'nope.json')).code, 2);
});
