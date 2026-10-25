/**
 * GET /bruno-web/selfcheck — a deployment check that exercises real behaviour
 * instead of "the process is up". Responds 200 only when every check passes.
 *
 * Checks:
 *   data-dir        the data directory is writable
 *   sqlite          node:sqlite can create, write and read a database
 *   quickjs         the Safe Mode sandbox evaluates an expression
 *   safe-mode       a runtime asked for developer mode ends up on QuickJS (when disallowed)
 *   http-request    upstream's HTTP client completes a round trip to this server
 *   metadata-block  connections to 169.254.169.254 are refused (when enabled)
 *   ipc-coverage    every channel the renderer uses has a main-process handler/listener
 *   electron-apis   no unimplemented Electron API has been touched
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const upstreamSrc = path.join(config.upstreamDir, 'packages', 'bruno-electron', 'src');
const jsEntry = () => require.resolve('@usebruno/js', { paths: [upstreamSrc] });

const loadRendererChannels = () => {
  const file = path.join(config.repoRoot, 'web', 'channels.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
};

const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))
]);

const checks = ({ shim }) => ({
  'data-dir': async () => {
    const probe = path.join(config.dataDir, `.selfcheck-${crypto.randomBytes(4).toString('hex')}`);
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.rm(probe);
    return config.dataDir;
  },

  'sqlite': async () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('ok');
    const row = db.prepare('SELECT v FROM t').get();
    db.close();
    if (row.v !== 'ok') throw new Error('unexpected row');
    return 'node:sqlite ok';
  },

  'quickjs': async () => {
    const quickjs = require(path.join(path.dirname(jsEntry()), 'sandbox', 'quickjs'));
    await quickjs.loader();
    const value = quickjs.executeQuickJsVm({ script: 'a + 1', context: { a: 41 }, scriptType: 'expression' });
    if (value !== 42) throw new Error(`expected 42, got ${value}`);
    return 'a + 1 = 42';
  },

  'safe-mode': async () => {
    if (config.allowDeveloperMode) return 'developer mode allowed by configuration';
    const { VarsRuntime, ScriptRuntime } = require(jsEntry());
    const vars = new VarsRuntime({ runtime: 'nodevm' });
    const script = new ScriptRuntime({ runtime: 'nodevm' });
    if (vars.runtime !== 'quickjs' || script.runtime !== 'quickjs') {
      throw new Error(`runtimes not forced to quickjs (vars=${vars.runtime}, script=${script.runtime})`);
    }
    return 'nodevm requests run on quickjs';
  },

  'http-request': async () => {
    const { makeAxiosInstance } = require(path.join(upstreamSrc, 'ipc', 'network', 'axios-instance'));
    const instance = makeAxiosInstance();
    const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
    const res = await withTimeout(instance.get(`http://${host}:${config.port}/bruno-web/healthz`), 5000, 'request');
    const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    if (res.status !== 200 || !body || body.ok !== true) throw new Error(`unexpected response ${res.status}`);
    return `GET /bruno-web/healthz -> ${res.status}`;
  },

  'metadata-block': async () => {
    if (!config.blockMetadataHosts) return 'disabled by configuration';
    const err = await new Promise((resolve) => {
      const socket = net.connect({ host: '169.254.169.254', port: 80 });
      const done = (e) => {
        socket.destroy();
        resolve(e || null);
      };
      socket.on('error', done);
      socket.on('connect', () => done(null));
      setTimeout(() => done(new Error('timeout')), 3000);
    });
    if (!err || err.code !== 'EBRUNOWEBBLOCKED') {
      throw new Error(`connection was not refused by policy (${err ? err.message : 'connected'})`);
    }
    return 'refused';
  },

  'ipc-coverage': async () => {
    const channels = loadRendererChannels();
    if (!channels) throw new Error('web/channels.json missing; run scripts/extract-channels.js');
    const { ipcMain } = shim;
    const handled = new Set([...ipcMain.handlerChannels(), ...ipcMain.eventNames().map(String)]);
    // Only channels the desktop main process serves count: a few renderer calls
    // (benchmark builds, dead gRPC helpers) have no handler upstream either.
    const desktop = new Set(channels.servedByDesktop);
    // benchmark:* exists only in upstream's benchmark builds, which Bruno Web does not produce.
    const used = [...channels.invoke, ...channels.send].filter((c) => desktop.has(c) && !c.startsWith('benchmark:'));
    const missing = used.filter((c) => !handled.has(c));
    if (missing.length) throw Object.assign(new Error(`${missing.length} renderer channels have no handler`), { detail: missing });
    return `${used.length} renderer channels served`;
  },

  'electron-apis': async () => {
    const missing = shim.getMissingApis();
    if (missing.length) throw Object.assign(new Error('unimplemented Electron APIs were used'), { detail: missing });
    return 'none missing';
  }
});

const createSelfcheck = (deps) => async (req, res) => {
  const results = {};
  let ok = true;
  for (const [name, run] of Object.entries(checks(deps))) {
    const started = Date.now();
    try {
      const detail = await withTimeout(Promise.resolve().then(run), 15000, name);
      results[name] = { ok: true, detail, ms: Date.now() - started };
    } catch (err) {
      ok = false;
      results[name] = { ok: false, error: err.message, detail: err.detail, ms: Date.now() - started };
    }
  }
  res.status(ok ? 200 : 500).json({ ok, results });
};

module.exports = { createSelfcheck };
