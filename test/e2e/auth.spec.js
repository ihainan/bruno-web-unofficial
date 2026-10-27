/** Password login, and the WebSocket refusing anything but a logged-in same-origin page. */
const WebSocket = require('ws');
const { test, expect } = require('./fixtures');

const PASSWORD = 'correct horse battery';

const tryWs = (url, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers });
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
  ws.on('error', (e) => resolve(e.message));
});

test('the app needs a login, and the socket only accepts the logged-in page', async ({ page, server }) => {
  const srv = await server({ env: { BRUNO_WEB_AUTH: 'password', BRUNO_WEB_PASSWORD: PASSWORD, BRUNO_WEB_TEST_HOOKS: 'false' } });
  await page.goto(`${srv.base}/`);
  await expect(page).toHaveURL(/\/bruno-web\/login$/);

  await page.fill('#password', 'wrong');
  await page.click('button[type=submit]');
  await expect(page.locator('.error')).toBeVisible();

  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'bruno_web_session');
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Strict');

  const wsUrl = `${srv.base.replace('http', 'ws')}/bruno-web/ws?page=x&last=0`;
  const cookie = `bruno_web_session=${session.value}`;
  expect(await tryWs(wsUrl, { Origin: srv.base })).toBe(401);
  expect(await tryWs(wsUrl, { Origin: 'http://evil.example', Cookie: cookie })).toBe(403);
  expect(await tryWs(wsUrl, { Cookie: cookie })).toBe(403);

  // Extra form fields (some browsers and extensions add them) must not break sign-in,
  // and errors never show a stack trace.
  const padded = await fetch(`${srv.base}/bruno-web/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD, extra: 'x'.repeat(20000) })
  });
  expect(padded.status).toBe(303);
  const tooBig = await fetch(`${srv.base}/bruno-web/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=x&extra=${'x'.repeat(400000)}`
  });
  const tooBigText = await tooBig.text();
  expect(tooBigText).not.toMatch(/at \w+ \(|node_modules/);
  expect(tooBigText).toContain('<form');

  const api = await fetch(`${srv.base}/bruno-web/api/fs/list`);
  expect(api.status).toBe(401);
  const evaluate = await fetch(`${srv.base}/bruno-web/test/evaluate`, { method: 'POST' });
  expect(evaluate.status).toBe(401);
});

test('home-screen icons and the manifest load without a login', async ({ page, server }) => {
  const srv = await server({ env: { BRUNO_WEB_AUTH: 'password', BRUNO_WEB_PASSWORD: PASSWORD, BRUNO_WEB_TEST_HOOKS: 'false' } });
  await page.goto(`${srv.base}/bruno-web/login`);
  const href = (rel) => page.locator(`link[rel="${rel}"]`).getAttribute('href');
  // Browsers fetch the manifest without cookies, so none of this may need a session.
  const manifest = await (await fetch(`${srv.base}${await href('manifest')}`)).json();
  expect(manifest.icons.map((i) => i.purpose)).toEqual(['any', 'any', 'maskable']);
  for (const src of [await href('apple-touch-icon'), ...manifest.icons.map((i) => i.src)]) {
    const res = await fetch(`${srv.base}${src}`);
    expect(res.status, src).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  }
  // The login page's CSP lets the browser use them.
  const csp = (await fetch(`${srv.base}/bruno-web/login`)).headers.get('content-security-policy');
  expect(csp).toContain("img-src 'self'");
  expect(csp).toContain("manifest-src 'self'");
});
