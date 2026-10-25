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

  const api = await fetch(`${srv.base}/bruno-web/api/fs/list`);
  expect(api.status).toBe(401);
  const evaluate = await fetch(`${srv.base}/bruno-web/test/evaluate`, { method: 'POST' });
  expect(evaluate.status).toBe(401);
});
