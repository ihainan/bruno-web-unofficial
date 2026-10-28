/**
 * OAuth 2.0 in the browser: upstream's sign-in window becomes a popup, and a
 * callback URL pointing at Bruno Web completes the flow by itself — including
 * the implicit grant, whose token only exists in the #fragment.
 */
const path = require('node:path');
const { test, expect, writeOauthCollection, openApp, webDialog } = require('./fixtures');

for (const grant of ['authorization_code', 'implicit']) {
  test(`${grant}: the popup lands on Bruno Web's callback and the request goes out with the token`, async ({ page, server, echo }) => {
    const srv = await server();
    writeOauthCollection(path.join(srv.workspace, 'oauth'), {
      name: 'oauth',
      grant,
      echoUrl: echo.url,
      callbackUrl: `${srv.base}/bruno-web/oauth2/callback`
    });
    await openApp(page, srv);
    await page.getByTestId('collections-header-add-menu').click();
    await page.locator('.tippy-box .dropdown-item').filter({ hasText: /open collection/i }).first().click();
    await webDialog(page).getByRole('option', { name: 'oauth' }).dblclick();
    await webDialog(page).getByRole('button', { name: /select this folder/i }).click();
    await page.locator('#sidebar-collection-name').filter({ hasText: 'oauth' }).click();
    await page.locator('.collection-item-name').filter({ hasText: 'protected' }).click();

    const popupPromise = page.waitForEvent('popup');
    await page.getByTestId('send-arrow-icon').click();
    const popup = await popupPromise;
    await popup.waitForEvent('close', { timeout: 20000 });

    await expect(page.getByTestId('response-status-code')).toContainText('200', { timeout: 20000 });
    const token = grant === 'implicit' ? 'implicit-token' : 'code-token';
    await expect(page.locator('.response-pane')).toContainText(`Bearer ${token}`);
    await expect(page.locator('bruno-web-ui .toast')).toHaveCount(0);
  });
}

test('cancelling while the popup shows another site says to close it, as the page may not', async ({ page, server, echo }) => {
  const srv = await server();
  // A callback that is not Bruno Web: the popup stays on another origin.
  writeOauthCollection(path.join(srv.workspace, 'oauth'), {
    name: 'oauth',
    grant: 'authorization_code',
    echoUrl: echo.url,
    callbackUrl: `${echo.url}/elsewhere`
  });
  await openApp(page, srv);
  await page.getByTestId('collections-header-add-menu').click();
  await page.locator('.tippy-box .dropdown-item').filter({ hasText: /open collection/i }).first().click();
  await webDialog(page).getByRole('option', { name: 'oauth' }).dblclick();
  await webDialog(page).getByRole('button', { name: /select this folder/i }).click();
  await page.locator('#sidebar-collection-name').filter({ hasText: 'oauth' }).click();
  await page.locator('.collection-item-name').filter({ hasText: 'protected' }).click();

  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('send-arrow-icon').click();
  const popup = await popupPromise;
  await popup.waitForURL(/\/elsewhere/);
  await page.locator('bruno-web-ui .panel .modal-foot').getByRole('button', { name: /^cancel$|^取消$/i }).click();

  await expect(page.locator('bruno-web-ui .toast').filter({ hasText: /close it yourself|手动关闭/ })).toHaveCount(1);
  expect(popup.isClosed()).toBe(false);
});
