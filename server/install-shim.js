/**
 * Route `require('electron')` (from upstream code and from packages such as
 * electron-store / electron-is-dev) to our shim. Must run before any upstream
 * module is loaded.
 *
 * Start the server with `node --require ./server/install-shim.js` so worker
 * threads (upstream's workerpool jobs) inherit the hook through execArgv.
 * NODE_OPTIONS is deliberately not used: it would leak into processes users
 * start from the terminal.
 */
const Module = require('node:module');
const path = require('node:path');

const SHIM = path.join(__dirname, 'electron-shim', 'index.js');

if (!Module._resolveFilename.__brunoWeb) {
  const originalResolve = Module._resolveFilename;
  const resolve = function (request, parent, ...rest) {
    if (request === 'electron') return SHIM;
    return originalResolve.call(this, request, parent, ...rest);
  };
  resolve.__brunoWeb = true;
  Module._resolveFilename = resolve;
}

// Electron defines this; upstream reads bundled files (sample collection) from it.
if (!process.resourcesPath) {
  const config = require('./config');
  process.resourcesPath = path.join(config.upstreamDir, 'packages', 'bruno-electron', 'resources');
}

module.exports = { SHIM };
