/**
 * Test-only route used by test/upstream-e2e: the stand-in for Playwright's
 * electronApp.evaluate(fn, arg), which runs `fn(electron, arg)` in the main
 * process (upstream specs use it to stub dialogs). Never enabled outside a
 * loopback, no-login test server.
 */
const express = require('express');
const config = require('./config');

const installTestHooks = (app, auth) => {
  if (!config.testHooks) return;
  if (auth.mode !== 'none' || !['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    throw new Error('BRUNO_WEB_TEST_HOOKS requires BRUNO_WEB_AUTH=none and a loopback HOST');
  }
  console.warn('[bruno-web] TEST HOOKS ENABLED: /bruno-web/test/evaluate runs arbitrary code');
  app.post('/bruno-web/test/evaluate', express.json({ limit: '10mb' }), async (req, res) => {
    // auth.userFor() in `none` mode accepts only loopback Host headers, and a
    // browser page cannot send this JSON body cross-origin without a preflight.
    if (!auth.userFor(req) || req.headers.origin) return res.status(403).json({ ok: false });
    try {
      // eslint-disable-next-line no-eval
      const fn = (0, eval)(`(${req.body.fn})`);
      const result = await fn(require('electron'), req.body.arg);
      res.json({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      res.json({ ok: false, error: { message: err && err.message, stack: err && err.stack } });
    }
  });
};

module.exports = { installTestHooks };
