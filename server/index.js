/**
 * Bruno Web server: serves the upstream Bruno renderer build, bridges its IPC
 * over a WebSocket to the upstream main-process code running in this process.
 *
 * Start with: node --require ./server/install-shim.js server/index.js
 */
require('./install-shim');

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { Auth } = require('./auth');
const { Policy } = require('./policy');
const { Hub } = require('./session');
const { createFsRouter, Downloads, sweepDownloadDirs } = require('./fs-api');
const { createSelfcheck } = require('./selfcheck');
const pages = require('./pages');

const APP_DIST = path.join(config.upstreamDir, 'packages', 'bruno-app', 'dist');
const WEB_DIR = path.join(config.repoRoot, 'web');

const ensureDirs = () => {
  for (const dir of [config.userDataDir, config.downloadsDir, config.uploadsDir, config.tmpDir, ...config.roots]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Upstream writes temp files via os.tmpdir(); keep them inside the data dir.
  process.env.TMPDIR = config.tmpDir;
};

const main = async () => {
  ensureDirs();
  if (!fs.existsSync(path.join(APP_DIST, 'index.html'))) {
    throw new Error(`Bruno renderer build not found at ${APP_DIST}; run scripts/fetch-upstream.sh first`);
  }

  // Upstream onboarding imports a sample collection on first launch unless told not to.
  if (!config.sampleCollection) process.env.DISABLE_SAMPLE_COLLECTION_IMPORT = 'true';

  const auth = new Auth();
  // Before anything else loads @usebruno/js (the policy below does).
  require('./upstream-main').loadSandboxAsAppHost();
  const policy = new Policy();
  policy.install();

  const electron = require('electron');
  const shim = electron.__bruno_web__;
  const downloads = new Downloads();
  const hub = new Hub({ ipcMain: shim.ipcMain, mainWindow: shim.mainWindow, policy, downloads });
  shim.setHub(hub);
  policy.setHub(hub);

  const upstream = await require('./upstream-main').start();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  const indexHtml = pages.buildIndexHtml(fs.readFileSync(path.join(APP_DIST, 'index.html'), 'utf8'));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const requestOrigin = (req) => {
    const proto = (config.trustProxy && req.headers['x-forwarded-proto']) || (req.secure ? 'https' : 'http');
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    return `${proto}://${host}`;
  };
  if (config.publicUrl) policy.setPublicOrigin(config.publicUrl);

  app.get('/bruno-web/healthz', (req, res) => res.json({ ok: true }));
  require('./test-hooks').installTestHooks(app, auth);

  app.get('/bruno-web/login', (req, res) => {
    if (auth.mode !== 'password') return res.redirect('/');
    res.setHeader('Content-Security-Policy', pages.LOGIN_CSP);
    res.type('html').send(pages.loginPage());
  });
  // Generous limit: browsers and extensions may add form fields; only `password` is read.
  app.post('/bruno-web/login', express.urlencoded({ extended: false, limit: '256kb' }), (req, res) => {
    if (auth.mode !== 'password') return res.redirect('/');
    const result = auth.login(req, req.body && req.body.password);
    if (!result.ok) {
      res.status(result.status);
      res.setHeader('Content-Security-Policy', pages.LOGIN_CSP);
      return res.type('html').send(pages.loginPage(result.error));
    }
    res.setHeader('Set-Cookie', result.cookie);
    res.redirect(303, '/');
  });
  app.post('/bruno-web/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.logout(req));
    res.redirect(303, '/bruno-web/login');
  });

  // OAuth2 redirect target. The identity provider sends the browser here from
  // another site, so the session cookie (SameSite=Strict) is not sent and the
  // implicit flow's token sits in the #fragment, which never reaches a server.
  // The page therefore only reads its own address and posts it back with a
  // same-origin request (which does carry the cookie) to the route below.
  app.get('/bruno-web/oauth2/callback', (req, res) => {
    res.setHeader('Content-Security-Policy', pages.CALLBACK_CSP);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(pages.oauthCallbackPage());
  });

  // Everything below needs a logged-in user.
  app.use((req, res, next) => {
    req.user = auth.userFor(req);
    if (req.user) {
      // Learn our public address from a request we trust, for the OAuth2 callback hint.
      if (!policy.publicOrigin) policy.setPublicOrigin(requestOrigin(req));
      const refreshed = auth.refreshCookie(req);
      if (refreshed) res.setHeader('Set-Cookie', refreshed);
      return next();
    }
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html') && auth.mode === 'password') {
      return res.redirect('/bruno-web/login');
    }
    res.status(401).json({ error: 'Not logged in' });
  });

  // State-changing API calls must come from our own page.
  app.use('/bruno-web/api', (req, res, next) => {
    if (req.method !== 'GET' && !auth.isSameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request refused' });
    next();
  });
  app.use('/bruno-web/api', createFsRouter({ policy, downloads }));
  // The page calls this now and then so the login cookie is renewed (see Auth.refreshCookie).
  app.get('/bruno-web/api/session', (req, res) => res.json({ user: req.user }));

  // Completes a pending OAuth2 authorization with the callback address the
  // popup landed on. Upstream still validates `state`.
  app.post('/bruno-web/api/oauth2/callback', express.json({ limit: '64kb' }), (req, res) => {
    const url = req.body && typeof req.body.url === 'string' ? req.body.url : '';
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (parsed.origin !== (policy.publicOrigin || requestOrigin(req)) || parsed.pathname !== '/bruno-web/oauth2/callback') {
      return res.status(400).json({ error: 'Not a Bruno Web callback address' });
    }
    let handled = hub.deliverAuthNavigation(null, url);
    if (!handled) {
      const { handleOauth2ProtocolUrl, isOauth2AuthorizationRequestInProgress } = require(
        path.join(config.upstreamDir, 'packages/bruno-electron/src/utils/oauth2-protocol-handler')
      );
      if (isOauth2AuthorizationRequestInProgress()) {
        handleOauth2ProtocolUrl(url);
        handled = true;
      }
    }
    res.json({ handled });
  });
  app.get('/bruno-web/selfcheck', createSelfcheck({ hub, policy, shim }));

  // Apps documents (upstream serves them on the bruno-app:// protocol).
  app.get('/bruno-web/app-doc/:token', async (req, res) => {
    const handler = shim.getProtocolHandler('bruno-app');
    if (!handler) return res.status(404).end();
    try {
      const response = await handler(new Request(`bruno-app://${req.params.token}/`));
      const html = await response.text();
      res.status(response.status);
      res.setHeader('Content-Security-Policy', pages.GUEST_CSP);
      res.type('html').send(pages.injectGuestBootstrap(html));
    } catch (e) {
      console.error('[bruno-web] app document failed', e);
      res.status(500).end();
    }
  });

  // HTML response previews. Served from a URL (not srcdoc/data:) so the
  // document gets its own sandbox CSP instead of inheriting the app's, which
  // would block the preview's scripts.
  const previews = new Map(); // token -> { html, expiresAt }
  app.put('/bruno-web/api/preview', express.text({ type: '*/*', limit: config.maxMessageBytes }), (req, res) => {
    const now = Date.now();
    for (const [k, v] of previews) if (v.expiresAt < now) previews.delete(k);
    while (previews.size >= 50) previews.delete(previews.keys().next().value);
    const token = crypto.randomBytes(18).toString('base64url');
    previews.set(token, { html: String(req.body || ''), expiresAt: now + 30 * 60 * 1000 });
    res.json({ url: `/bruno-web/preview/${token}` });
  });
  app.get('/bruno-web/preview/:token', (req, res) => {
    const entry = previews.get(req.params.token);
    if (!entry) return res.status(404).type('text').send('Preview expired');
    res.setHeader('Content-Security-Policy', pages.GUEST_CSP);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(pages.injectGuestBootstrap(entry.html));
  });

  // Start-up settings the bridge needs synchronously, before the renderer runs.
  app.get('/bruno-web/config.js', (req, res) => {
    const settings = {
      uploadsDir: config.uploadsDir,
      sep: path.sep,
      platform: process.platform,
      roots: config.roots,
      auth: auth.mode,
      user: req.user,
      terminal: config.enableTerminal,
      playwright: config.playwright,
      debugIpc: config.debugIpc,
      maxMessageBytes: config.maxMessageBytes,
      developerMode: config.allowDeveloperMode
    };
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').send(`window.__BRUNO_WEB__ = ${JSON.stringify(settings).replace(/</g, '\\u003c')};`);
  });

  app.use('/bruno-web/static', express.static(WEB_DIR, { index: false, maxAge: 0 }));

  const sendIndex = (req, res) => {
    res.setHeader('Content-Security-Policy', pages.APP_CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(indexHtml);
  };
  app.get(['/', '/index.html'], sendIndex);
  app.use(express.static(APP_DIST, { index: false }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Never show a stack trace to the browser. Body-parser errors (size, bad
  // encoding) are client errors; anything else is ours.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[bruno-web] request failed', req.method, req.path, err);
    else console.warn(`[bruno-web] ${req.method} ${req.path}: ${err.message} (content-type ${req.headers['content-type'] || '-'}, length ${req.headers['content-length'] || '-'})`);
    if (res.headersSent) return;
    if (req.path === '/bruno-web/login') {
      res.status(status);
      res.setHeader('Content-Security-Policy', pages.LOGIN_CSP);
      return res.type('html').send(pages.loginPage('Sign-in failed, please try again'));
    }
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });

  server.on('upgrade', (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      console.error('[bruno-web] rejected WebSocket upgrade', err);
      socket.destroy();
    }
  });

  const handleUpgrade = (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/bruno-web/ws') return reject(404, 'Not Found');
    if (!auth.isSameOrigin(req)) return reject(403, 'Forbidden');
    if (!auth.userFor(req)) return reject(401, 'Unauthorized');
    const pageId = url.searchParams.get('page') || crypto.randomUUID();
    const lastSeq = Number(url.searchParams.get('last') || 0);
    if (!policy.publicOrigin) policy.setPublicOrigin(requestOrigin(req));
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.authHeaders = { ...req.headers };
      // Oversized frames and protocol errors close this socket only.
      ws.on('error', (err) => console.warn('[bruno-web] WebSocket error', err.message));
      ws.on('message', () => auth.touch(ws.authHeaders));
      hub.attach(ws, { pageId, lastSeq });
    });
  };

  // Close sockets whose login has expired or been revoked (logout elsewhere).
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!auth.isValid({ headers: ws.authHeaders })) {
        try { ws.send(require('../web/codec').encode({ t: 'auth-expired' })); } catch (e) {}
        ws.close(4401, 'login expired');
      }
    }
  }, 30 * 1000).unref();
  sweepDownloadDirs();
  setInterval(() => {
    downloads.sweep();
    sweepDownloadDirs();
  }, 10 * 60 * 1000).unref();

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[bruno-web] listening on http://${config.host}:${config.port} (auth: ${auth.mode}, data: ${config.dataDir})`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[bruno-web] ${signal}: shutting down`);
    if (auth.mode === 'password') auth.saveSessions();
    server.close();
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    let code = 0;
    try {
      await Promise.race([upstream.shutdown(), new Promise((r) => setTimeout(r, 8000))]);
    } catch (err) {
      console.error('[bruno-web] shutdown failed:', err);
      code = 1;
    } finally {
      // Again: requests still in flight may have extended a session meanwhile.
      if (auth.mode === 'password') auth.saveSessions();
      process.exit(code);
    }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
};

main().catch((err) => {
  console.error('[bruno-web] failed to start:', err);
  process.exit(1);
});
