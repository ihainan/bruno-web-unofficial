/**
 * Loaded into the Playwright runner. Some upstream specs require main-process
 * modules directly, which `require('electron')` at load time. Under plain Node
 * the real package only exports the path of the Electron binary (a string);
 * Bruno Web installs it without that binary, which makes the package throw.
 * Resolve it to the same kind of value instead.
 */
const Module = require('node:module');
const path = require('node:path');

const STUB = path.join(__dirname, 'electron-path-value.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};
