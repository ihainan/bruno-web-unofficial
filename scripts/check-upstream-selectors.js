#!/usr/bin/env node
/**
 * Checks that every upstream class name, data-testid and id our touch-screen
 * styles and scripts select on still exists in upstream's renderer source.
 * An upstream rename otherwise fails silently: the rule just stops matching
 * (this is how the "unsaved changes" prompt broke once).
 *
 *   scripts/check-upstream-selectors.js       exit 1 and list what is missing
 *
 * Names we create ourselves start with `bw-` or `bruno-` and are skipped.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const upstream = process.env.BRUNO_WEB_UPSTREAM || path.join(repoRoot, 'upstream');
const appSrc = path.join(upstream, 'packages', 'bruno-app', 'src');

// Files that select on upstream markup, and how to find selectors in them.
const SOURCES = [
  { file: 'web/mobile.css', css: true },
  { file: 'web/mobile.js' },
  { file: 'web/bridge.js' }
];
const OWN = /^(bw-|bruno-)/;
// Generic names that are not a contract with upstream markup.
const IGNORE = new Set(['tippy-box', 'tippy-content', 'webview', 'row', 'toasts']);

const stripComments = (text, css) => (css ? text.replace(/\/\*[\s\S]*?\*\//g, '') : text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''));

// CSS: everything before each `{` is a selector list (skipping @media lines).
// JS: string literals that look like selectors.
const selectorTexts = (text, css) => {
  if (css) {
    return [...text.matchAll(/([^{}]+)\{/g)].map((m) => m[1]).filter((s) => !s.trim().startsWith('@'));
  }
  return [...text.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)]
    .map((m) => m[2])
    .filter((s) => /[.#[]/.test(s) && !s.includes('${'));
};

const unescapeCss = (name) => name.replace(/\\(.)/g, '$1');

const collect = () => {
  const wanted = new Map(); // "class:foo" -> Set of files
  const add = (kind, name, file) => {
    if (!name || OWN.test(name) || IGNORE.has(name)) return;
    const key = `${kind}:${name}`;
    if (!wanted.has(key)) wanted.set(key, new Set());
    wanted.get(key).add(file);
  };
  for (const { file, css } of SOURCES) {
    const text = stripComments(fs.readFileSync(path.join(repoRoot, file), 'utf8'), css);
    for (const sel of selectorTexts(text, css)) {
      // Drop attribute selectors, but not escaped brackets in class names
      // such as .w-\[50\%\].
      const plain = sel.replace(/(?<!\\)\[[^\]]*(?<!\\)\]/g, ' ');
      for (const m of plain.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
        // Skip things like "0.2s" or file extensions inside non-selector strings.
        if (/^\d/.test(m[1])) continue;
        add('class', unescapeCss(m[1]), file);
      }
      for (const m of plain.matchAll(/#([A-Za-z][\w-]*)/g)) add('id', m[1], file);
      for (const m of sel.matchAll(/\[data-testid=["']?([^"'\]]+)["']?\]/g)) add('testid', m[1], file);
    }
  }
  return wanted;
};

const walk = (dir, out) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== 'node_modules') walk(full, out);
    } else if (/\.(js|jsx|ts|tsx|css|scss)$/.test(d.name) && !/\.(spec|test)\./.test(d.name)) {
      out.push(fs.readFileSync(full, 'utf8'));
    }
  }
  return out;
};

const main = () => {
  if (!fs.existsSync(appSrc)) {
    console.error(`upstream renderer source not found at ${appSrc} (run scripts/fetch-upstream.sh)`);
    process.exit(2);
  }
  const source = walk(appSrc, []).join('\n');
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const missing = [];
  const wanted = collect();
  for (const [key, files] of wanted) {
    const [kind, name] = key.split(/:(.*)/s);
    // A class or id is a token in a className string, a styled-components
    // selector or a template; a test id appears as a string literal.
    const re = kind === 'testid'
      ? new RegExp(`["'\`]${escape(name)}["'\`]`)
      : new RegExp(`(^|[^A-Za-z0-9_-])${escape(name)}($|[^A-Za-z0-9_-])`, 'm');
    if (!re.test(source)) missing.push(`${kind} "${name}" (used in ${[...files].join(', ')})`);
  }
  if (missing.length) {
    console.error(`${missing.length} of ${wanted.size} upstream names we rely on no longer appear in ${appSrc}:`);
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
  console.log(`all ${wanted.size} upstream class names, ids and test ids we rely on still exist`);
};

main();
