#!/usr/bin/env node
/**
 * Judges a run of upstream's e2e suite (scripts/upstream-e2e.sh) against
 * test/upstream-e2e/known-failures.txt.
 *
 *   scripts/compare-upstream-results.js results.json [rerun-results.json ...] [--json summary.json] [--failed-files out.txt]
 *
 * Later result files override earlier ones test by test (use this for a rerun
 * of the failed files). Exit 0 when every failure is a listed one, 1 when
 * there are new failures, 2 on bad input.
 *
 * A test counts as:
 *   passed         passed on the first attempt
 *   flaky          passed after upstream's retries (reported separately)
 *   known          failed and is listed in known-failures.txt
 *   failed         failed and is not listed
 *   not run        skipped without an upstream skip annotation (a serial group
 *                  stopped after an earlier failure, or the run was cut short);
 *                  counted as failed unless a known failure in the same file explains it
 *   skipped        skipped by upstream (test.skip / fixme)
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const KNOWN_FILE = path.join(repoRoot, 'test', 'upstream-e2e', 'known-failures.txt');

const parseArgs = (argv) => {
  const out = { files: [], json: null, failedFiles: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = argv[++i];
    else if (argv[i] === '--failed-files') out.failedFiles = argv[++i];
    else out.files.push(argv[i]);
  }
  return out;
};

const loadKnown = () => {
  const known = new Map();
  for (const raw of fs.readFileSync(KNOWN_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [id, reason = ''] = line.split(/\s+#\s+/);
    known.set(id.trim(), reason.trim());
  }
  return known;
};

// Flatten Playwright's JSON report into { id -> { file, outcome } }.
const loadResults = (file) => {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tests = new Map();
  const walk = (suite, titles) => {
    const here = suite.file && suite.title === suite.file ? titles : [...titles, suite.title].filter(Boolean);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const id = [spec.file, ...here.filter((x) => x !== spec.file), spec.title].join(' › ');
        const key = `${t.projectName || ''}|${id}`;
        const upstreamSkip = (t.annotations || []).some((a) => a.type === 'skip' || a.type === 'fixme');
        let outcome;
        if (t.status === 'expected') outcome = t.results.length > 1 ? 'flaky' : 'passed';
        else if (t.status === 'flaky') outcome = 'flaky';
        else if (t.status === 'skipped') outcome = upstreamSkip ? 'skipped' : 'not run';
        else outcome = 'failed';
        tests.set(key, { id, file: spec.file, project: t.projectName, outcome });
      }
    }
    for (const child of suite.suites || []) walk(child, here);
  };
  for (const s of report.suites || []) walk(s, []);
  return tests;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.files.length) {
    console.error('usage: compare-upstream-results.js results.json [rerun.json ...] [--json out] [--failed-files out]');
    process.exit(2);
  }
  const known = loadKnown();
  const tests = new Map();
  for (const f of args.files) {
    if (!fs.existsSync(f)) {
      console.error(`missing results file: ${f}`);
      process.exit(2);
    }
    // Only tests that actually ran override the earlier result.
    for (const [key, t] of loadResults(f)) {
      if (!tests.has(key) || t.outcome !== 'not run') tests.set(key, t);
    }
  }

  const summary = { total: tests.size, passed: 0, flaky: [], known: [], failed: [], notRun: [], skipped: 0, knownNowPassing: [] };
  const filesWithKnown = new Set();
  for (const t of tests.values()) if (t.outcome === 'failed' && known.has(t.id)) filesWithKnown.add(t.file);
  for (const t of tests.values()) {
    if (t.outcome === 'passed') summary.passed += 1;
    else if (t.outcome === 'skipped') summary.skipped += 1;
    else if (t.outcome === 'flaky') summary.flaky.push(t.id);
    else if (t.outcome === 'failed') (known.has(t.id) ? summary.known : summary.failed).push(t.id);
    else if (t.outcome === 'not run') (filesWithKnown.has(t.file) ? summary.known : summary.notRun).push(t.id);
    if (known.has(t.id) && (t.outcome === 'passed' || t.outcome === 'flaky')) summary.knownNowPassing.push(t.id);
  }
  const listed = new Set([...tests.values()].map((t) => t.id));
  summary.knownMissing = [...known.keys()].filter((id) => !listed.has(id));

  const bad = [...summary.failed, ...summary.notRun];
  const lines = [
    `upstream e2e: ${summary.total} tests`,
    `  passed first time   ${summary.passed}`,
    `  passed after retry  ${summary.flaky.length}`,
    `  known failures      ${summary.known.length}`,
    `  NEW failures        ${summary.failed.length}`,
    `  did not run         ${summary.notRun.length}`,
    `  skipped by upstream ${summary.skipped}`
  ];
  for (const id of summary.failed) lines.push(`  FAILED   ${id}`);
  for (const id of summary.notRun) lines.push(`  NOT RUN  ${id}`);
  for (const id of summary.flaky) lines.push(`  flaky    ${id}`);
  for (const id of summary.knownNowPassing) lines.push(`  listed as known but passes now (remove it): ${id}`);
  for (const id of summary.knownMissing) lines.push(`  listed as known but no longer exists (remove it): ${id}`);
  console.log(lines.join('\n'));

  if (args.json) fs.writeFileSync(args.json, JSON.stringify(summary, null, 2));
  if (args.failedFiles) {
    const files = [...new Set([...tests.values()].filter((t) => bad.includes(t.id)).map((t) => t.file))];
    fs.writeFileSync(args.failedFiles, files.join('\n') + (files.length ? '\n' : ''));
  }
  process.exit(bad.length ? 1 : 0);
};

main();
