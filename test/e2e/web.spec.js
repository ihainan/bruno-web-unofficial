/**
 * Behaviour that exists only in Bruno Web: the server-side file dialogs,
 * uploads and downloads, the WebSocket session (reload, reconnect, takeover),
 * the <webview> stand-in and the server's policies. Upstream behaviour is
 * covered by running upstream's own suite (scripts/upstream-e2e.sh).
 */
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, writeCollection, writeRequest, openApp, webDialog } = require('./fixtures');

const openCollectionViaDialog = async (page, folderName) => {
  await page.getByTestId('collections-header-add-menu').click();
  await page.locator('.tippy-box .dropdown-item').filter({ hasText: /open collection/i }).first().click();
  const dialog = webDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('option', { name: folderName }).dblclick();
  await dialog.getByRole('button', { name: /select this folder/i }).click();
  await expect(dialog).toBeHidden();
};

const sidebarItem = (page, name) => page.locator('.collection-item-name').filter({ hasText: name });
const collectionRow = (page, name) => page.locator('#sidebar-collection-name').filter({ hasText: name });

const openRequest = async (page, collection, request) => {
  const row = sidebarItem(page, request);
  if (!(await row.isVisible())) await collectionRow(page, collection).click();
  await row.click();
};

const send = async (page, status = 200) => {
  await page.getByTestId('send-arrow-icon').click();
  await expect(page.getByTestId('response-status-code')).toContainText(String(status), { timeout: 30000 });
};

test('open a collection through the server file dialog, send a request, see the response', async ({ page, server, echo }) => {
  const srv = await server();
  writeCollection(path.join(srv.workspace, 'demo'), 'demo', [{ name: 'echo-get', url: `${echo.url}/hello?x=1` }]);
  await openApp(page, srv);

  await openCollectionViaDialog(page, 'demo');
  await expect(collectionRow(page, 'demo')).toBeVisible();
  await openRequest(page, 'demo', 'echo-get');
  await send(page);
  await expect(page.locator('.response-pane')).toContainText('/hello?x=1');
});

test('a request file changed on disk shows up in the page, also after a reload', async ({ page, server, echo }) => {
  const srv = await server();
  const dir = path.join(srv.workspace, 'live');
  writeCollection(dir, 'live', [{ name: 'first', url: `${echo.url}/first` }]);
  await openApp(page, srv);
  await openCollectionViaDialog(page, 'live');
  await collectionRow(page, 'live').click();
  await expect(sidebarItem(page, 'first')).toBeVisible();

  writeRequest(dir, { name: 'added-on-disk', url: `${echo.url}/added` }, 2);
  await expect(sidebarItem(page, 'added-on-disk')).toBeVisible();

  await page.reload();
  await page.locator('[data-app-state="loaded"]').waitFor();
  await expect(collectionRow(page, 'live')).toBeVisible();
  // The mount service must still be watching after the reload.
  writeRequest(dir, { name: 'after-reload', url: `${echo.url}/after` }, 3);
  if (!(await sidebarItem(page, 'first').isVisible())) await collectionRow(page, 'live').click();
  await expect(sidebarItem(page, 'after-reload')).toBeVisible();
});

test('a dropped connection resumes without a reload and loses nothing', async ({ page, server, echo }) => {
  const srv = await server();
  const dir = path.join(srv.workspace, 'net');
  writeCollection(dir, 'net', [{ name: 'slow', url: `${echo.url}/slow` }]);
  await openApp(page, srv);
  await openCollectionViaDialog(page, 'net');
  await collectionRow(page, 'net').click();
  await openRequest(page, 'net', 'slow');
  await page.evaluate(() => { window.__sameDocument = true; });

  // Start a 3-second request, then cut the socket while it is in flight and
  // change a file while the page is disconnected.
  await page.getByTestId('send-arrow-icon').click();
  await page.waitForTimeout(300);
  await srv.evaluate(({ __bruno_web__ }) => {
    __bruno_web__.getHub().ws.terminate();
  });
  writeRequest(dir, { name: 'while-offline', url: `${echo.url}/x` }, 2);

  await expect(page.getByTestId('response-status-code')).toContainText('200', { timeout: 30000 });
  await expect(page.locator('.response-pane')).toContainText('"slow":true');
  await expect(sidebarItem(page, 'while-offline')).toBeVisible();
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
});

test('a second tab takes over and the first one says so', async ({ page, context, server }) => {
  const srv = await server();
  await openApp(page, srv);
  const second = await context.newPage();
  await openApp(second, srv);
  await expect(page.locator('bruno-web-ui [role="alertdialog"]')).toContainText(/another tab|其他标签页/);
  // Taking over again from the first tab reloads it and it works.
  await page.locator('bruno-web-ui [role="alertdialog"] button').click();
  await page.locator('[data-app-state="loaded"]').waitFor();
  await expect(second.locator('bruno-web-ui [role="alertdialog"]')).toBeVisible();
});

test('an HTML response renders in the sandboxed preview and its scripts run', async ({ page, server, echo }) => {
  const srv = await server();
  writeCollection(path.join(srv.workspace, 'html'), 'html', [{ name: 'page', url: `${echo.url}/html` }]);
  await openApp(page, srv);
  await openCollectionViaDialog(page, 'html');
  await openRequest(page, 'html', 'page');
  await send(page);

  // HTML responses open in preview mode (the <webview> stand-in).
  const frame = page.frameLocator('.response-pane webview iframe');
  await expect(frame.locator('#greeting')).toHaveText('Hello from the preview');
  await expect(frame.locator('body')).toHaveAttribute('data-ran', 'yes');
});

test('import a collection file from this computer, export it back as a download', async ({ page, server, echo }) => {
  const srv = await server();
  const exported = {
    info: { name: 'imported-api', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'ping', request: { method: 'GET', url: `${echo.url}/ping` } }]
  };
  const local = path.join(srv.dataDir, 'local-postman.json');
  fs.writeFileSync(local, JSON.stringify(exported));
  await openApp(page, srv);

  await page.getByTestId('collections-header-add-menu').click();
  await page.locator('.tippy-box .dropdown-item').filter({ hasText: /import/i }).first().click();
  const modal = page.locator('.bruno-modal-card').filter({ hasText: /import/i });
  await expect(modal).toBeVisible();
  await modal.locator('input[type="file"]').first().setInputFiles(local);

  // The location picker for the imported collection is our server dialog.
  const locationModal = page.locator('.bruno-modal-card').filter({ hasText: 'Location' });
  await expect(locationModal).toBeVisible({ timeout: 15000 });
  await locationModal.getByText('Browse', { exact: true }).click();
  const dialog = webDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /select this folder/i }).click();
  await locationModal.getByRole('button', { name: /import/i }).click();
  await expect(collectionRow(page, 'imported-api')).toBeVisible({ timeout: 15000 });

  // Export as ZIP: the save dialog offers "download to this computer".
  const row = page.getByTestId('collections').locator('.collection-name').filter({ hasText: 'imported-api' });
  await row.hover();
  await row.locator('.collection-actions .icon').click({ force: true });
  await page.locator('.tippy-box .dropdown-item').filter({ hasText: /^Share$/ }).click();
  const shareModal = page.locator('.bruno-modal-card').filter({ hasText: 'Share Collection' });
  await shareModal.getByText('Bruno Collection (ZIP)').click();
  await shareModal.getByRole('button', { name: 'Proceed' }).click();
  await expect(dialog).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await dialog.locator('.modal-foot .btn.primary').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
});

test('safe mode is enforced and our settings are invisible to scripts', async ({ page, server, echo }) => {
  const srv = await server({ env: { BRUNO_WEB_PROXY_SECRET: 'top-secret-value' } });
  const dir = path.join(srv.workspace, 'sec');
  writeCollection(dir, 'sec', [{
    name: 'leak',
    url: `${echo.url}/leak`,
    script: "req.setHeader('x-leak', String(bru.getProcessEnv('BRUNO_WEB_PROXY_SECRET')));"
  }]);
  await openApp(page, srv);
  await openCollectionViaDialog(page, 'sec');
  await openRequest(page, 'sec', 'leak');
  await send(page);
  await expect(page.locator('.response-pane')).toContainText('"x-leak": "undefined"');
  await expect(page.locator('.response-pane')).not.toContainText('top-secret-value');

  // A collection in developer mode still runs on QuickJS: Node's require is not there.
  const runtime = await srv.evaluate(async () => {
    const js = require(require.resolve('@usebruno/js', { paths: [process.resourcesPath] }));
    return new js.ScriptRuntime({ runtime: 'nodevm' }).runtime;
  }).catch((e) => e.message);
  expect(runtime).toBe('quickjs');
});

test('the terminal and npm installs are refused by default', async ({ page, server }) => {
  const srv = await server();
  await openApp(page, srv);
  const results = await page.evaluate(async () => {
    const out = {};
    for (const [ch, args] of [['terminal:create', [{}]], ['renderer:install-postman-packages', ['/tmp', ['left-pad']]]]) {
      try {
        await window.ipcRenderer.invoke(ch, ...args);
        out[ch] = 'allowed';
      } catch (e) {
        out[ch] = e.message;
      }
    }
    return out;
  });
  expect(results['terminal:create']).toMatch(/terminal is disabled/);
  expect(results['renderer:install-postman-packages']).toMatch(/runs code on the server/);
});
