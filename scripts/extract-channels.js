#!/usr/bin/env node
/**
 * Collects the IPC channel names the renderer uses (static string literals in
 * packages/bruno-app/src) into web/channels.json. /bruno-web/selfcheck compares
 * them with what the main process registered, which is how an upstream upgrade
 * that adds a channel we do not serve gets noticed.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const upstream = process.env.BRUNO_WEB_UPSTREAM || path.join(repoRoot, 'upstream');
const appSrc = path.join(upstream, 'packages', 'bruno-app', 'src');
const mainSrc = path.join(upstream, 'packages', 'bruno-electron', 'src');

const walk = (dir, files) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name === 'node_modules' || d.name === 'test-utils') continue;
      walk(full, files);
    } else if (/\.(js|jsx|ts|tsx)$/.test(d.name) && !/\.(spec|test)\./.test(d.name)) {
      files.push(full);
    }
  }
  return files;
};
const files = walk(appSrc, []);

const found = { invoke: new Set(), send: new Set(), on: new Set() };
// Direct calls, callIpc() from utils/common/ipc.js, and helpers that receive a
// destructured or aliased `invoke` — every `invoke('<channel>')` counts.
const direct = /ipcRenderer\??\.(send|on|once)\(\s*(['"])([^'"`]+)\2/g;
const invokes = /\b(?:invoke|callIpc)\(\s*(['"])([^'"`]+)\1/g;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(direct)) {
    const kind = m[1] === 'once' ? 'on' : m[1];
    found[kind].add(m[3]);
  }
  for (const m of text.matchAll(invokes)) found.invoke.add(m[2]);
}

// What the desktop main process itself serves. Renderer channels missing from
// here are unhandled in the desktop app too, so they are not ours to serve.
const served = new Set();
for (const file of walk(mainSrc, [])) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/ipcMain\.(?:handle|handleOnce|on|once)\(\s*(['"])([^'"`]+)\1/g)) served.add(m[2]);
}
found.servedByDesktop = served;

const out = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]));
fs.writeFileSync(path.join(repoRoot, 'web', 'channels.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`renderer: invoke ${out.invoke.length}, send ${out.send.length}, on ${out.on.length}; desktop main serves ${out.servedByDesktop.length} -> web/channels.json`);
