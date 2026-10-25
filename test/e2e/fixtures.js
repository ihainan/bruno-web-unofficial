/**
 * Fixtures for Bruno Web's own end-to-end tests (the browser-specific parts
 * upstream's suite cannot cover): each test gets a fresh server process with
 * its own data directory, plus a small HTTP echo server to send requests to.
 */
const { test: base, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const startServer = async ({ env = {}, fresh = false } = {}) => {
  const port = await freePort();
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-web-test-')));
  const workspace = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  // Skip the welcome modal, as upstream's own fixtures do.
  if (!fresh) seedPreferences(dataDir);
  let log = '';
  const proc = spawn(process.execPath, ['--require', path.join(REPO, 'server/install-shim.js'), path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      BRUNO_WEB_DATA: dataDir,
      BRUNO_WEB_AUTH: 'none',
      BRUNO_WEB_TEST_HOOKS: 'true',
      BRUNO_WEB_SAMPLE_COLLECTION: 'false',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited: ${log}`);
    try {
      if ((await fetch(`${base}/bruno-web/healthz`)).ok) break;
    } catch (e) {}
    if (Date.now() > deadline) throw new Error(`server did not start: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    port,
    dataDir,
    workspace,
    log: () => log,
    async evaluate(fn, arg) {
      const res = await fetch(`${base}/bruno-web/test/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fn: fn.toString(), arg: arg === undefined ? null : arg })
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ? body.error.message : `evaluate ${res.status}`);
      return body.result;
    },
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
};

const seedPreferences = (dataDir) => {
  const userData = path.join(dataDir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'preferences.json'), JSON.stringify({
    preferences: { onboarding: { hasLaunchedBefore: true, hasSeenWelcomeModal: true, lastSeenVersion: '2.0.0' }, ai: { enabled: false } }
  }));
};

const startEcho = async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/html')) {
        res.setHeader('Content-Type', 'text/html');
        return res.end('<html><head><title>t</title></head><body><h1 id="greeting">Hello from the preview</h1><script>document.body.dataset.ran = "yes"; console.log("preview script ran")</script></body></html>');
      }
      // A minimal OAuth 2.0 identity provider.
      if (req.url.startsWith('/authorize')) {
        const q = new URL(req.url, 'http://x').searchParams;
        const redirect = q.get('redirect_uri');
        const state = encodeURIComponent(q.get('state') || '');
        res.statusCode = 302;
        res.setHeader('Location', q.get('response_type') === 'token'
          ? `${redirect}#access_token=implicit-token&token_type=Bearer&expires_in=3600&state=${state}`
          : `${redirect}?code=the-code&state=${state}`);
        return res.end();
      }
      if (req.url.startsWith('/token')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ access_token: body.includes('the-code') ? 'code-token' : 'unexpected', token_type: 'Bearer', expires_in: 3600 }));
      }
      if (req.url.startsWith('/large')) {
        // ~50 MB of JSON, generated rather than buffered in memory twice.
        res.setHeader('Content-Type', 'application/json');
        const row = JSON.stringify({ id: 0, name: 'employee', email: 'someone@example.com', department: 'engineering', notes: 'x'.repeat(200) });
        res.write('[');
        for (let i = 0; i < 180000; i++) res.write((i ? ',' : '') + row);
        return res.end(']');
      }
      if (req.url.startsWith('/slow')) {
        return setTimeout(() => res.end(JSON.stringify({ slow: true })), 3000);
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', 'echo_session=abc123; Path=/');
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
};

/** Writes a YAML collection with the given requests ({ name, method, url, script? }). */
const writeCollection = (dir, name, requests) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencollection.yml'), `opencollection: "1.0.0"\ninfo:\n  name: ${name}\n`);
  requests.forEach((r, i) => writeRequest(dir, r, i + 1));
};

const writeRequest = (dir, r, seq = 1) => {
  const script = r.script ? `\nruntime:\n  scripts:\n    - type: before-request\n      code: |-\n${r.script.split('\n').map((l) => `        ${l}`).join('\n')}\n` : '';
  fs.writeFileSync(path.join(dir, `${r.name}.yml`), `info:\n  name: ${r.name}\n  type: http\n  seq: ${seq}\n\nhttp:\n  method: ${r.method || 'GET'}\n  url: ${r.url}\n  body:\n    type: none\n${script}`);
};

/** A .bru collection with one request that uses OAuth 2.0 (fetched automatically on send). */
const writeOauthCollection = (dir, { name, grant, echoUrl, callbackUrl }) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bruno.json'), JSON.stringify({ version: '1', name, type: 'collection' }));
  const common = `  callback_url: ${callbackUrl}
  authorization_url: ${echoUrl}/authorize
  client_id: bruno-web
  scope: read
  state: 
  token_placement: header
  token_header_prefix: Bearer
  auto_fetch_token: true
  auto_refresh_token: false`;
  const auth = grant === 'implicit'
    ? `auth:oauth2 {\n  grant_type: implicit\n${common}\n}\n`
    : `auth:oauth2 {\n  grant_type: authorization_code\n${common}\n  access_token_url: ${echoUrl}/token\n  refresh_token_url: \n  client_secret: s3cret\n  pkce: false\n  credentials_placement: body\n  credentials_id: credentials\n}\n`;
  fs.writeFileSync(path.join(dir, 'protected.bru'), `meta {\n  name: protected\n  type: http\n  seq: 1\n}\n\nget {\n  url: ${echoUrl}/protected\n  body: none\n  auth: oauth2\n}\n\n${auth}`);
};

const test = base.extend({
  echo: async ({}, use) => {
    const echo = await startEcho();
    await use(echo);
    await echo.close();
  },
  server: async ({}, use) => {
    let srv = null;
    await use(async (opts) => {
      srv = await startServer(opts);
      return srv;
    });
    if (srv) await srv.stop();
  }
});

/** Opens Bruno and waits until the renderer has loaded. */
const openApp = async (page, srv) => {
  await page.goto(`${srv.base}/`);
  await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
};

/** The Bruno Web dialogs live in a shadow root; Playwright's locators pierce it. */
const webDialog = (page) => page.locator('bruno-web-ui [role="dialog"]');

module.exports = { test, expect, startServer, seedPreferences, writeCollection, writeRequest, writeOauthCollection, openApp, webDialog, REPO };
