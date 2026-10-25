const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const pages = require('../../server/pages');

// Inline scripts are template strings; a quoting slip breaks them silently in the browser.
const inlineScripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

for (const [name, html] of Object.entries({
  login: pages.loginPage(),
  loginWithError: pages.loginPage('Wrong password'),
  oauthCallback: pages.oauthCallbackPage(),
  guestBootstrap: pages.injectGuestBootstrap('<html><head></head><body></body></html>')
})) {
  test(`${name} page scripts parse`, () => {
    const scripts = inlineScripts(html);
    assert.ok(scripts.length > 0);
    for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code));
  });
}

test('the renderer index gets the bridge before the app bundle', () => {
  const html = pages.buildIndexHtml('<!DOCTYPE html><html><head><script defer src="/static/js/index.js"></script></head><body></body></html>');
  assert.ok(html.indexOf('/bruno-web/static/bridge.js') < html.indexOf('/static/js/index.js'));
  assert.ok(html.indexOf('/bruno-web/config.js') < html.indexOf('/bruno-web/static/bridge.js'));
});
