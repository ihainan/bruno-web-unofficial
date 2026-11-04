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
  // A desktop browser has no phone mode, nor the button to it.
  await expect(page.locator('[data-testid^="bw-phone"]')).toHaveCount(0);
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

test('leaving the page asks first only when a tab has unsaved changes', async ({ page, server, echo }) => {
  const srv = await server();
  writeCollection(path.join(srv.workspace, 'drafts'), 'drafts', [{ name: 'draft-me', url: `${echo.url}/a` }]);
  await openApp(page, srv);
  await openCollectionViaDialog(page, 'drafts');
  await openRequest(page, 'drafts', 'draft-me');
  await expect(page.locator('.request-tab').filter({ hasText: 'draft-me' })).toBeVisible();

  const asked = [];
  page.on('dialog', (d) => {
    asked.push(d.type());
    d.dismiss();
  });
  await page.reload();
  await page.locator('[data-app-state="loaded"]').waitFor();
  expect(asked).toEqual([]);

  await openRequest(page, 'drafts', 'draft-me');
  await page.locator('#request-url .CodeMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type('/changed');
  await expect(page.locator('.close-gradient.has-changes')).toHaveCount(1);
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toEqual(['beforeunload']);
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

test('a 50 MB response reaches the page and gets the large-response warning', async ({ page, server, echo }) => {
  test.setTimeout(120000);
  const srv = await server();
  writeCollection(path.join(srv.workspace, 'large'), 'large', [{ name: 'large', url: `${echo.url}/large` }]);
  await openApp(page, srv);
  await openCollectionViaDialog(page, 'large');
  await openRequest(page, 'large', 'large');
  await send(page);
  await expect(page.getByText('Large Response Warning')).toBeVisible({ timeout: 60000 });
  expect(srv.log()).not.toMatch(/over the limit/);
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
  const shareItem = page.locator('.tippy-box .dropdown-item').filter({ hasText: /^Share$/ });
  // The actions icon only appears on hover; retry until the menu is really open.
  await expect(async () => {
    await row.hover();
    await row.locator('.collection-actions .icon').click({ force: true });
    await expect(shareItem).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  await shareItem.click();
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

test('Bruno\'s zoom is left to the browser: the layout keeps filling the window', async ({ page, server }) => {
  const srv = await server();
  await openApp(page, srv);
  const fills = () => page.evaluate(() => {
    const main = document.getElementById('main-container').getBoundingClientRect();
    return { zoom: document.documentElement.style.zoom, bottom: Math.round(main.bottom), height: innerHeight };
  });
  const toasts = page.locator('bruno-web-ui .toast');

  // Preferences > Display > Zoom 90 %: not applied as CSS zoom (which left a
  // gap under the app and skewed drags), but the user is told what to use.
  await page.evaluate(() => window.ipcRenderer.invoke('renderer:set-zoom-level', Math.log(0.9) / Math.log(1.2)));
  await expect(toasts.filter({ hasText: /browser|浏览器/ })).toHaveCount(1);
  const after = await fills();
  expect(after.zoom).toBe('');
  expect(after.bottom).toBe(after.height);

  // Bruno's zoom shortcut does not reach Bruno, so the browser zooms instead.
  await page.keyboard.press('Control+Minus');
  await page.keyboard.press('Control+Equal');
  await page.waitForTimeout(1000);
  await expect(toasts).toHaveCount(1);
});

test('the diff stylesheet Bruno links with the wrong letter case loads', async ({ page, server }) => {
  const srv = await server();
  await openApp(page, srv);
  await expect.poll(() => page.evaluate(() => {
    const sheet = [...document.styleSheets].find((s) => (s.href || '').endsWith('/static/diff2html.min.css'));
    try {
      return sheet.cssRules.length;
    } catch {
      return -1; // missing, or not loaded as a stylesheet
    }
  })).toBeGreaterThan(0);
});

test('over plain http on a LAN address, copy actions still reach the clipboard', async ({ playwright, server, echo }) => {
  // Any name other than localhost is an insecure origin over http, like a LAN IP.
  const browser = await playwright.chromium.launch({ args: ['--host-resolver-rules=MAP bruno-lan.test 127.0.0.1'] });
  try {
    const page = await browser.newPage();
    const srv = await server({ env: { BRUNO_WEB_AUTH: 'password', BRUNO_WEB_PASSWORD: 'lan', BRUNO_WEB_TEST_HOOKS: 'false' } });
    writeCollection(path.join(srv.workspace, 'demo'), 'demo', [{ name: 'echo-get', url: `${echo.url}/hello?x=1` }]);
    await page.goto(`${srv.base.replace('127.0.0.1', 'bruno-lan.test')}/`);
    await page.fill('#password', 'lan');
    await page.press('#password', 'Enter');
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    await page.evaluate(() => {
      window.__copied = [];
      document.addEventListener('copy', () => window.__copied.push(document.activeElement.value));
    });

    await openCollectionViaDialog(page, 'demo');
    await openRequest(page, 'demo', 'echo-get');
    await send(page);
    await page.getByTestId('response-actions-menu').click();
    await page.locator('[role="menuitem"][data-item-id="copy-response"]').click();
    await expect(page.getByText('Response copied to clipboard')).toBeVisible();
    expect(await page.evaluate(() => window.__copied.join(''))).toContain('/hello?x=1');
  } finally {
    await browser.close();
  }
});

test('the app menu\'s window actions do what a browser tab can, or say what to use', async ({ page, server }) => {
  const srv = await server();
  await openApp(page, srv);
  const toasts = page.locator('bruno-web-ui .toast');
  const pick = async (label) => {
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByText('View', { exact: true }).hover();
    await page.getByText(label, { exact: true }).click();
  };

  await pick('Full Screen');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await pick('Full Screen');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);

  await pick('Developer Tools');
  await expect(toasts.filter({ hasText: /developer tools|开发者工具/i })).toHaveCount(1);

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByText('File', { exact: true }).hover();
  await page.getByText('Quit', { exact: true }).click();
  await expect(toasts.filter({ hasText: /close this browser tab|关闭这个浏览器标签页/ })).toHaveCount(1);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  // Phone mode (phone/index.js) lists the workspace's collections. Put one
  // there the way opening it once in the full interface would.
  const addToWorkspace = (srv, name) => {
    const file = path.join(srv.dataDir, 'userData', 'default-workspace', 'workspace.yml');
    const entry = `  - name: "${name}"\n    path: "../../workspace/${name}"\n`;
    if (fs.existsSync(file)) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^collections:.*\n/m, `collections:\n${entry}`));
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `opencollection: 1.0.0\ninfo:\n  name: "My Workspace"\n  type: workspace\n\ncollections:\n${entry}\nspecs:\n\ndocs: ''\n`);
    }
  };
  const phoneCollection = (page, name) => page.getByTestId('bw-phone-collection').filter({ hasText: name });
  // The tree's row, not the same request's row under Recent.
  const phoneRequest = (page, name) => page.getByTestId('bw-phone-request').filter({ hasText: name }).last();
  const title = (page) => page.locator('.bw-phone-header .bw-title-text');
  const urlView = (page) => page.getByTestId('bw-phone-url-view');
  const setUrl = async (page, url) => {
    await urlView(page).tap();
    await page.getByTestId('bw-phone-url').fill(url);
    await page.getByTestId('bw-phone-url').blur();
  };
  const fullInterface = async (page) => {
    const menu = page.getByTestId('bw-phone-menu');
    await ((await menu.isVisible()) ? menu : page.getByTestId('bw-phone-more')).tap();
    await page.getByTestId('bw-phone-full').tap();
    await expect(page.getByTestId('bw-phone')).toHaveCount(0);
  };
  const openPhoneRequest = async (page, collection, request) => {
    await phoneCollection(page, collection).tap();
    await phoneRequest(page, request).tap();
    await expect(title(page)).toHaveText(request);
  };
  const sendAndWait = async (page) => {
    await page.getByTestId('bw-phone-send').tap();
    await expect(page.getByTestId('bw-phone-status')).toBeVisible({ timeout: 30000 });
  };
  // The response body is a CodeMirror editor; its text is the document, not the DOM.
  const bodyText = (page) => page.getByTestId('bw-phone-response-body').locator('.CodeMirror').evaluate((el) => el.CodeMirror.getValue());
  // WebKit has no clipboard permission to grant, so record what the page copies.
  const captureClipboard = (page) => page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); }, readText: async () => window.__copied[window.__copied.length - 1] || '' } });
  });
  const copied = (page) => page.evaluate(() => window.__copied[window.__copied.length - 1] || '');
  const writeEnv = (dir, name, vars) => {
    fs.mkdirSync(path.join(dir, 'environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'environments', `${name}.yml`), `name: ${name}\n\nvariables:\n${vars.map(([n, v]) => `  - name: ${n}\n    value: ${v}\n`).join('')}`);
  };

  test('phone mode: change a request\'s method and URL, send the unsaved draft, save it, find it in the full interface', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [{ name: 'echo-get', url: `${echo.url}/phone?a=1` }]);
    fs.mkdirSync(path.join(dir, 'nested'));
    writeRequest(path.join(dir, 'nested'), { name: 'deep-one', url: `${echo.url}/deep` });
    addToWorkspace(srv, 'phone');
    await openApp(page, srv);

    // Collections and folders open in place; a collection loads when first opened.
    await phoneCollection(page, 'phone').tap();
    await page.getByTestId('bw-phone-folder').filter({ hasText: 'nested' }).tap();
    await expect(phoneRequest(page, 'deep-one')).toBeVisible();
    await phoneRequest(page, 'echo-get').tap();
    await expect(title(page)).toHaveText('echo-get');

    await page.getByTestId('bw-phone-method').selectOption('POST');
    await setUrl(page, `${echo.url}/phone?a=2`);
    await expect(urlView(page)).toHaveText(`${echo.url}/phone?a=2`);
    await expect(page.getByTestId('bw-phone-save')).toBeVisible();
    // The URL's query is the Params tab's table.
    await expect(page.getByTestId('bw-phone-params-row')).toHaveCount(1);
    await expect(page.getByTestId('bw-phone-params-value-view')).toHaveText('2');

    // The unsaved draft survives a trip to the full interface and back.
    await fullInterface(page);
    await expect(page.locator('.request-tab').filter({ hasText: 'echo-get' }).locator('.close-gradient.has-changes')).toHaveCount(1);
    await page.getByTestId('bw-phone-switch').tap();
    await expect(urlView(page)).toHaveText(`${echo.url}/phone?a=2`);
    await expect(page.getByTestId('bw-phone-method')).toHaveValue('POST');

    // What is sent is the draft on the screen, not the saved file.
    await sendAndWait(page);
    await expect(page.getByTestId('bw-phone-status')).toContainText('200');
    expect(await bodyText(page)).toContain('"method": "POST"');
    expect(await bodyText(page)).toContain('/phone?a=2');
    // The body gets the screen below the status and tabs.
    expect((await page.getByTestId('bw-phone-response-body').boundingBox()).height).toBeGreaterThan(450);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.getByTestId('bw-phone-back').tap();
    await expect(page.getByTestId('bw-phone-last-response')).toContainText('200');
    await page.getByTestId('bw-phone-save').tap();
    await expect(page.getByTestId('bw-phone-save')).toHaveCount(0);
    const saved = fs.readFileSync(path.join(dir, 'echo-get.yml'), 'utf8');
    expect(saved).toContain('method: POST');
    expect(saved).toContain('/phone?a=2');

    // The full interface is on the same request, with its response; and back.
    await fullInterface(page);
    await expect(page.locator('.request-tab').filter({ hasText: 'echo-get' })).toBeVisible();
    await expect(page.getByTestId('response-status-code')).toContainText('200');
    await page.getByTestId('bw-phone-switch').tap();
    await expect(title(page)).toHaveText('echo-get');
    await expect(urlView(page)).toHaveText(`${echo.url}/phone?a=2`);
  });

  test('phone mode: search finds requests inside folders; recent requests come first; a new request opens ready to send', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [{ name: 'echo-get', url: `${echo.url}/phone` }]);
    fs.mkdirSync(path.join(dir, 'nested'));
    writeRequest(path.join(dir, 'nested'), { name: 'deep-one', url: `${echo.url}/deep` });
    addToWorkspace(srv, 'phone');
    await openApp(page, srv);
    await phoneCollection(page, 'phone').tap();
    await expect(phoneRequest(page, 'echo-get')).toBeVisible();

    // By name, and by address.
    await page.getByTestId('bw-phone-search').fill('DEEP-');
    await expect(phoneRequest(page, 'deep-one')).toContainText('phone / nested');
    await expect(phoneRequest(page, 'echo-get')).toHaveCount(0);
    await page.getByTestId('bw-phone-search').fill('/deep');
    await phoneRequest(page, 'deep-one').tap();
    await expect(title(page)).toHaveText('deep-one');
    // Back finds the list as it was left.
    await page.getByTestId('bw-phone-back').tap();
    await expect(page.getByTestId('bw-phone-search')).toHaveValue('/deep');
    await page.getByTestId('bw-phone-search').fill('');
    await expect(page.locator('section[aria-label="Recent"]').getByTestId('bw-phone-request')).toHaveText(/deep-one/);

    // A request file that does not parse opens upstream's notice, not the crash page.
    fs.writeFileSync(path.join(dir, 'broken.yml'), 'info:\n  name: broken\n  type: http\n\nhttp:\n  url: [unclosed\n  : : :\n');
    await phoneRequest(page, 'broken').tap();
    await expect(page.getByTestId('bw-phone')).toBeVisible();
    await expect(page.getByText('Oops! Something went wrong')).toHaveCount(0);
    await page.getByTestId('bw-phone-back').tap();

    // New request: name, method and URL in one sheet; it opens once its file exists.
    await page.getByTestId('bw-phone-new-request').tap();
    await page.getByTestId('bw-phone-new-name').fill('made-on-a-phone');
    await page.getByTestId('bw-phone-new-method').selectOption('POST');
    await page.getByTestId('bw-phone-new-url').fill(`${echo.url}/new`);
    await page.getByTestId('bw-phone-new-create').tap();
    await expect(title(page)).toHaveText('made-on-a-phone');
    await expect.poll(() => fs.existsSync(path.join(dir, 'made-on-a-phone.yml'))).toBe(true);
    await sendAndWait(page);
    expect(await bodyText(page)).toContain('/new');
    expect(await bodyText(page)).toContain('"method": "POST"');

    // A new folder, and a request from a cURL command inside it.
    await page.getByTestId('bw-phone-back').tap();
    await page.getByTestId('bw-phone-back').tap();
    await page.getByTestId('bw-phone-collection-menu').tap();
    await page.getByTestId('bw-phone-action-new-folder').tap();
    await page.getByTestId('bw-phone-new-name').fill('orders');
    await page.getByTestId('bw-phone-new-create').tap();
    await expect.poll(() => fs.existsSync(path.join(dir, 'orders'))).toBe(true);
    await page.locator('.bw-row-wrap').filter({ has: page.getByTestId('bw-phone-folder').filter({ hasText: 'orders' }) }).getByTestId('bw-phone-folder-menu').tap();
    await page.getByTestId('bw-phone-action-new-request').tap();
    await page.getByTestId('bw-phone-new-name').fill('from-curl');
    await page.getByTestId('bw-phone-new-curl-toggle').tap();
    await page.getByTestId('bw-phone-new-curl').fill(`curl -X PUT ${echo.url}/curl -H 'X-From: curl' -d '{"a":1}'`);
    await page.getByTestId('bw-phone-new-create').tap();
    await expect(title(page)).toHaveText('from-curl');
    await expect.poll(() => fs.existsSync(path.join(dir, 'orders', 'from-curl.yml'))).toBe(true);
    await sendAndWait(page);
    const echoed = await bodyText(page);
    expect(echoed).toContain('"method": "PUT"');
    expect(echoed).toContain('"x-from": "curl"');
  });

  test('phone mode: a variable prompt can be cancelled, a slow request can be stopped, a failed request says so, leaving with unsaved changes asks first', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [{ name: 'ask', url: `${echo.url}/item/{{?Item id}}` }]);
    addToWorkspace(srv, 'phone');
    const asked = [];
    page.on('dialog', (d) => {
      asked.push(d.type());
      d.dismiss();
    });
    await openApp(page, srv);
    await openPhoneRequest(page, 'phone', 'ask');

    // Cancelling the prompt sends nothing and stays on the request.
    await page.getByTestId('bw-phone-send').tap();
    const prompt = page.getByTestId('prompt-variables-modal-content');
    await expect(prompt).toBeVisible();
    await page.locator('.bruno-modal').getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(prompt).toBeHidden();
    await expect(urlView(page)).toBeVisible();
    await expect(page.getByTestId('bw-phone-send')).toBeEnabled();

    await page.getByTestId('bw-phone-send').tap();
    await page.getByTestId('prompt-variable-input-0').fill('42');
    await page.locator('.bruno-modal').getByRole('button', { name: 'Continue', exact: true }).tap();
    await expect(page.getByTestId('bw-phone-status')).toContainText('200');
    expect(await bodyText(page)).toContain('/item/42');

    // While a request is under way it cannot be sent again, and it can be stopped.
    await page.getByTestId('bw-phone-back').tap();
    await setUrl(page, `${echo.url}/slow`);
    await page.getByTestId('bw-phone-send').tap();
    await expect(page.getByTestId('bw-phone-sending')).toBeVisible();
    await page.getByTestId('bw-phone-back').tap();
    await expect(page.getByTestId('bw-phone-send')).toBeDisabled();
    await page.getByTestId('bw-phone-last-response').tap();
    await page.getByTestId('bw-phone-cancel').tap();
    await expect(page.getByTestId('bw-phone-sending')).toHaveCount(0);
    await page.getByTestId('bw-phone-back').tap();
    await expect(page.getByTestId('bw-phone-send')).toBeEnabled();
    await page.getByTestId('bw-phone-save').tap();
    await expect(page.getByTestId('bw-phone-save')).toHaveCount(0);

    // Nothing unsaved yet: leaving does not ask.
    await page.reload();
    await page.locator('[data-app-state="loaded"]').waitFor();
    expect(asked).toEqual([]);

    // After a reload the request is one tap away under Recent.
    await page.locator('section[aria-label="Recent"]').getByTestId('bw-phone-request').filter({ hasText: 'ask' }).tap();
    await expect(title(page)).toHaveText('ask');
    // Nothing listens on port 9: the error shows instead of a spinner.
    await setUrl(page, 'http://127.0.0.1:9/nothing');
    await page.getByTestId('bw-phone-send').tap();
    await expect(page.getByTestId('bw-phone-response-error')).toContainText(/ECONNREFUSED|connect/i);
    await expect(page.getByTestId('bw-phone-sending')).toHaveCount(0);

    await page.close({ runBeforeUnload: true });
    await expect.poll(() => asked).toEqual(['beforeunload']);
  });

  test('phone mode: environments: pick one, see and change a variable from the URL, edit and save the environment', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [{ name: 'with-vars', url: "'{{host}}/env?t={{token}}'" }]);
    writeEnv(dir, 'dev', [['host', echo.url], ['token', 'first']]);
    writeEnv(dir, 'prod', [['host', echo.url], ['token', 'prod-token']]);
    addToWorkspace(srv, 'phone');
    await openApp(page, srv);
    await openPhoneRequest(page, 'phone', 'with-vars');

    // Without an environment the variables are unknown.
    await expect(page.getByTestId('bw-phone-var').first()).toHaveClass(/bw-var-invalid/);
    await page.getByTestId('bw-phone-env').tap();
    await page.getByTestId('bw-phone-env-choice').filter({ hasText: 'dev' }).tap();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('bw-phone-env')).toHaveText(/dev/);
    await expect(page.getByTestId('bw-phone-var').first()).toHaveClass(/bw-var-valid/);

    // A variable's value, changed in place, is saved to the environment file.
    await page.getByTestId('bw-phone-var').filter({ hasText: 'token' }).tap();
    await expect(page.getByTestId('bw-phone-var-value')).toHaveText('first');
    await page.getByTestId('bw-phone-var-edit').tap();
    await page.getByTestId('bw-phone-var-input').fill('second');
    await page.getByTestId('bw-phone-var-save').tap();
    await expect.poll(() => fs.readFileSync(path.join(dir, 'environments', 'dev.yml'), 'utf8')).toContain('second');

    // The environment sheet edits as a draft until Save.
    await page.getByTestId('bw-phone-env').tap();
    const values = page.getByTestId('bw-phone-env-var-value');
    await values.nth(1).fill('third');
    await expect(page.getByTestId('bw-phone-env-unsaved')).toBeVisible();
    await page.getByTestId('bw-phone-env-save').tap();
    await expect(page.getByTestId('bw-phone-env-unsaved')).toHaveCount(0);
    await expect.poll(() => fs.readFileSync(path.join(dir, 'environments', 'dev.yml'), 'utf8')).toContain('third');

    // An unsaved change to one environment is not lost by switching to another:
    // it has to be saved or dropped before the other can be edited.
    await values.nth(1).fill('fourth');
    await page.getByTestId('bw-phone-env-choice').filter({ hasText: 'prod' }).tap();
    await expect(page.getByTestId('bw-phone-env-other-draft')).toContainText('dev');
    await expect(page.getByTestId('bw-phone-env-var-value')).toHaveCount(0);
    await page.getByTestId('bw-phone-env-other-draft').getByRole('button', { name: 'Save' }).tap();
    await expect.poll(() => fs.readFileSync(path.join(dir, 'environments', 'dev.yml'), 'utf8')).toContain('fourth');
    await expect(page.getByTestId('bw-phone-env-var-value').nth(1)).toHaveValue('prod-token');
    await page.getByTestId('bw-phone-env-choice').filter({ hasText: 'dev' }).tap();
    await values.nth(1).fill('third');
    await page.getByTestId('bw-phone-env-save').tap();
    await expect.poll(() => fs.readFileSync(path.join(dir, 'environments', 'dev.yml'), 'utf8')).toContain('third');
    await page.keyboard.press('Escape');

    await sendAndWait(page);
    expect(await bodyText(page)).toContain('/env?t=third');
  });

  test('phone mode: the response\'s headers, what was sent, test results, search, JSONPath filter, copy', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [{
      name: 'checked',
      url: `${echo.url}/checked?x=1`,
      tests: 'test("status is 200", () => expect(res.getStatus()).to.equal(200));\ntest("is created", () => expect(res.getStatus()).to.equal(201));'
    }]);
    addToWorkspace(srv, 'phone');
    await captureClipboard(page);
    await openApp(page, srv);
    await openPhoneRequest(page, 'phone', 'checked');
    await sendAndWait(page);

    const tabs = page.getByTestId('bw-phone-response-tabs');
    await expect(tabs.getByTestId('bw-tab-tests')).toContainText('1/2');
    await tabs.getByTestId('bw-tab-headers').tap();
    await expect(page.getByTestId('bw-phone-response')).toContainText('set-cookie');
    await tabs.getByTestId('bw-tab-timeline').tap();
    await expect(page.getByTestId('bw-phone-sent-url')).toContainText(`${echo.url}/checked?x=1`);
    await tabs.getByTestId('bw-tab-tests').tap();
    const results = page.getByTestId('bw-phone-test-result');
    await expect(results).toHaveCount(2);
    await expect(results.filter({ hasText: 'is created' })).toContainText('expected 200 to equal 201');

    // Search marks every match; the JSONPath filter shows just a part.
    await page.getByTestId('bw-phone-find').tap();
    await page.getByTestId('bw-phone-find-input').fill('checked');
    await expect(page.getByTestId('bw-phone-find-count')).toHaveText('1 / 1');
    await expect(page.locator('.bw-hit-current')).toHaveCount(1);
    await page.getByRole('button', { name: 'Filter by JSON path' }).tap();
    await page.getByTestId('bw-phone-find-input').fill('$.method');
    await expect.poll(() => bodyText(page)).toContain('GET');
    expect(await bodyText(page)).not.toContain('headers');
    await page.getByTestId('bw-phone-find-done').tap();
    await expect.poll(() => bodyText(page)).toContain('"headers"');

    // Copy the body.
    await page.getByTestId('bw-phone-response-menu').tap();
    await page.getByTestId('bw-phone-action-copy-body').tap();
    await expect.poll(() => copied(page)).toContain('/checked?x=1');

    // Save as example: stored in the request file.
    await page.getByTestId('bw-phone-response-menu').tap();
    await page.getByTestId('bw-phone-action-example').tap();
    await page.getByTestId('bw-phone-example-input').fill('ok example');
    await page.getByTestId('bw-phone-example-ok').tap();
    await expect.poll(() => fs.readFileSync(path.join(dir, 'checked.yml'), 'utf8')).toContain('ok example');
  });

  test('phone mode: request menu: copy as cURL, generate code, clone, rename, move, delete', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [{ name: 'original', url: `${echo.url}/orig` }]);
    fs.mkdirSync(path.join(dir, 'archive'));
    writeRequest(path.join(dir, 'archive'), { name: 'old', url: `${echo.url}/old` });
    addToWorkspace(srv, 'phone');
    await captureClipboard(page);
    await openApp(page, srv);
    await openPhoneRequest(page, 'phone', 'original');

    await page.getByTestId('bw-phone-menu').tap();
    await page.getByTestId('bw-phone-action-curl').tap();
    await expect.poll(() => copied(page)).toContain(`curl --request GET`);

    await page.getByTestId('bw-phone-menu').tap();
    await page.getByTestId('bw-phone-action-code').tap();
    await expect(page.getByTestId('bw-phone-code-text')).toContainText(`${echo.url}/orig`);
    await page.getByTestId('bw-phone-code-language').selectOption({ label: 'JavaScript-fetch' });
    await expect(page.getByTestId('bw-phone-code-text')).toContainText('fetch(');
    await page.keyboard.press('Escape');

    // Clone opens the copy.
    await page.getByTestId('bw-phone-menu').tap();
    await page.getByTestId('bw-phone-action-clone').tap();
    await page.getByTestId('bw-phone-clone-input').fill('the-copy');
    await page.getByTestId('bw-phone-clone-ok').tap();
    await expect(title(page)).toHaveText('the-copy');
    await expect.poll(() => fs.existsSync(path.join(dir, 'the-copy.yml'))).toBe(true);

    // Rename renames the file too.
    await page.getByTestId('bw-phone-menu').tap();
    await page.getByTestId('bw-phone-action-rename').tap();
    await page.getByTestId('bw-phone-rename-input').fill('renamed');
    await page.getByTestId('bw-phone-rename-ok').tap();
    await expect(title(page)).toHaveText('renamed');
    await expect.poll(() => fs.existsSync(path.join(dir, 'renamed.yml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'the-copy.yml'))).toBe(false);

    // Move into a folder.
    await page.getByTestId('bw-phone-menu').tap();
    await page.getByTestId('bw-phone-action-move').tap();
    await page.getByTestId('bw-phone-move').getByRole('radio', { name: 'archive' }).tap();
    await page.getByTestId('bw-phone-move-ok').tap();
    await expect.poll(() => fs.existsSync(path.join(dir, 'archive', 'renamed.yml'))).toBe(true);

    // Delete asks first, then removes the file and goes back to the list.
    await page.getByTestId('bw-phone-back').tap();
    await phoneRequest(page, 'original').tap();
    await page.getByTestId('bw-phone-menu').tap();
    await page.getByTestId('bw-phone-action-delete').tap();
    await page.getByTestId('bw-phone-delete-ok').tap();
    await expect.poll(() => fs.existsSync(path.join(dir, 'original.yml'))).toBe(false);
    await expect(page.getByTestId('bw-phone-search')).toBeVisible();
  });

  test('phone mode: editing params in bulk, headers, auth, request vars, a form body and a script reaches the request that is sent', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [{ name: 'edited', method: 'POST', url: `${echo.url}/edit` }]);
    addToWorkspace(srv, 'phone');
    await openApp(page, srv);
    await openPhoneRequest(page, 'phone', 'edited');

    // Params in bulk become the URL's query.
    await page.getByTestId('bw-phone-params-bulk').tap();
    await page.getByTestId('bw-phone-params-bulk-text').fill('a:1\n//b:2\nc:{{who}}\ntag:x\ntag:y');
    await page.getByTestId('bw-phone-params-bulk-done').tap();
    await expect(urlView(page)).toHaveText(`${echo.url}/edit?a=1&c={{who}}&tag=x&tag=y`);
    // Rows with the same name stay separate rows after another bulk edit.
    await page.getByTestId('bw-phone-params-bulk').tap();
    await page.getByTestId('bw-phone-params-bulk-done').tap();
    await page.getByTestId('bw-phone-params-row').filter({ hasText: 'tag' }).last().getByRole('checkbox').uncheck();
    await expect(urlView(page)).toHaveText(`${echo.url}/edit?a=1&c={{who}}&tag=x`);

    // A header.
    await page.getByTestId('bw-tab-headers').tap();
    await page.getByTestId('bw-phone-headers-add').tap();
    await page.getByTestId('bw-phone-headers-name').last().fill('X-Phone');
    await page.getByTestId('bw-phone-headers-value-view').last().tap();
    await page.getByTestId('bw-phone-headers-value').fill('yes');

    // Bearer auth, through upstream's own auth form.
    await page.getByTestId('bw-tab-auth').tap();
    await page.getByTestId('bw-phone-auth-mode').selectOption('bearer');
    await page.locator('.bw-upstream-form .CodeMirror').first().click();
    await page.keyboard.type('tok-123');

    // A request variable used in the query.
    await page.getByTestId('bw-tab-vars').tap();
    await page.getByTestId('bw-phone-req-vars-add').tap();
    await page.getByTestId('bw-phone-req-vars-name').last().fill('who');
    await page.getByTestId('bw-phone-req-vars-value-view').last().tap();
    await page.getByTestId('bw-phone-req-vars-value').fill('me');

    // A form body.
    await page.getByTestId('bw-tab-body').tap();
    await page.getByTestId('bw-phone-body-mode').selectOption('formUrlEncoded');
    await page.getByTestId('bw-phone-form-add').tap();
    await page.getByTestId('bw-phone-form-name').last().fill('field');
    await page.getByTestId('bw-phone-form-value-view').last().tap();
    await page.getByTestId('bw-phone-form-value').fill('value one');

    // A pre-request script, typed with the symbol keys' help.
    await page.getByTestId('bw-tab-script').tap();
    await page.getByTestId('bw-phone-script-editor').locator('.CodeMirror').click();
    await page.keyboard.type('req.setHeader("X-Script", "ran")');
    await page.getByRole('toolbar', { name: 'Symbols' }).getByRole('button', { name: ';', exact: true }).tap();
    await expect.poll(() => page.getByTestId('bw-phone-script-editor').locator('.CodeMirror').evaluate((el) => el.CodeMirror.getValue())).toBe('req.setHeader("X-Script", "ran");');

    await sendAndWait(page);
    const sent = JSON.parse(await bodyText(page));
    expect(sent.url).toBe('/edit?a=1&c=me&tag=x');
    expect(sent.headers['x-phone']).toBe('yes');
    expect(sent.headers.authorization).toBe('Bearer tok-123');
    expect(sent.headers['x-script']).toBe('ran');
    expect(sent.body).toBe('field=value+one');

    await page.getByTestId('bw-phone-back').tap();
    await page.getByTestId('bw-phone-save').tap();
    await expect.poll(() => fs.readFileSync(path.join(dir, 'edited.yml'), 'utf8')).toContain('X-Phone');
  });

  test('phone mode: a GraphQL request has the desktop pane\'s tabs, so the full interface shows the same one', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [{ name: 'plain', url: `${echo.url}/plain` }]);
    addToWorkspace(srv, 'phone');
    await openApp(page, srv);
    await phoneCollection(page, 'phone').tap();
    await page.getByTestId('bw-phone-new-request').tap();
    await page.getByRole('radio', { name: 'GraphQL' }).tap();
    await page.getByTestId('bw-phone-new-name').fill('gql');
    await page.getByTestId('bw-phone-new-url').fill(`${echo.url}/graphql`);
    await page.getByTestId('bw-phone-new-create').tap();
    await expect(title(page)).toHaveText('gql');
    const tabs = page.getByTestId('bw-phone-request-tabs');
    await expect(tabs.getByTestId('bw-tab-query')).toBeVisible();
    await expect(tabs.getByTestId('bw-tab-params')).toHaveCount(0);
    await tabs.getByTestId('bw-tab-headers').tap();
    await tabs.getByTestId('bw-tab-query').tap();
    await fullInterface(page);
    await expect(page.getByText('Not found')).toHaveCount(0);
    await expect(page.locator('.request-tab').filter({ hasText: 'gql' })).toBeVisible();
  });

  test('phone mode: run a whole collection and see which requests failed', async ({ page, server, echo }) => {
    const srv = await server();
    const dir = path.join(srv.workspace, 'phone');
    writeCollection(dir, 'phone', [
      { name: 'one', url: `${echo.url}/one`, tests: 'test("ok", () => expect(res.getStatus()).to.equal(200));' },
      { name: 'two', url: `${echo.url}/two`, tests: 'test("wrong", () => expect(res.getStatus()).to.equal(404));' },
      { name: 'three', url: `${echo.url}/three` },
      { name: 'four', url: `${echo.url}/four`, script: 'bru.runner.skipRequest();' }
    ]);
    addToWorkspace(srv, 'phone');
    await openApp(page, srv);
    await phoneCollection(page, 'phone').tap();
    await expect(phoneRequest(page, 'three')).toBeVisible();
    await page.getByTestId('bw-phone-collection-menu').tap();
    await page.getByTestId('bw-phone-action-run').tap();
    await page.getByTestId('bw-phone-run-start').tap();
    await expect(page.getByTestId('bw-phone-run-passed')).toHaveText('2 passed', { timeout: 30000 });
    await expect(page.getByTestId('bw-phone-run-failed')).toHaveText('1 failed');
    await expect(page.getByTestId('bw-phone-runner')).toContainText('1 skipped');
    await expect(page.getByTestId('bw-phone-run-row').filter({ hasText: 'four' }).locator('.bw-spinner')).toHaveCount(0);
    const failed = page.getByTestId('bw-phone-run-row').filter({ hasText: 'two' });
    await expect(failed).toContainText('expected 200 to equal 404');
    await failed.tap();
    await expect(page.getByTestId('bw-phone-run-detail')).toContainText('wrong');
  });

  test('turned sideways a phone stays in phone mode; a tablet gets the full interface', async ({ page, server }) => {
    const srv = await server();
    await openApp(page, srv);
    await expect(page.getByTestId('bw-phone')).toBeVisible();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByTestId('bw-phone')).toBeVisible();
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.getByTestId('bw-phone')).toHaveCount(0);
    await expect(page.getByTestId('bw-phone-switch')).toHaveCount(0);
    await expect(page.getByTestId('toggle-sidebar-button')).toBeVisible();
  });

  test('full interface: the sidebar is a drawer, request and response stack, nothing scrolls sideways', async ({ page, server, echo }) => {
    const srv = await server();
    writeCollection(path.join(srv.workspace, 'phone'), 'phone', [{ name: 'echo-get', url: `${echo.url}/phone` }]);
    await openApp(page, srv);
    await fullInterface(page);
    const toggle = page.getByTestId('toggle-sidebar-button');
    const collapsedLabel = await toggle.getAttribute('aria-label');

    // Closed by default; Bruno's sidebar button opens the drawer.
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('bw-drawer-open'))).toBe(false);
    await toggle.tap();
    await expect(page.locator('html')).toHaveClass(/bw-drawer-open/);

    await page.getByTestId('collections-header-add-menu').tap();
    await page.locator('.tippy-box .dropdown-item').filter({ hasText: /open collection/i }).first().tap();
    // On a touch screen a tap opens the folder; the button picks the folder shown.
    await webDialog(page).getByRole('option', { name: 'phone' }).tap();
    await expect(webDialog(page).locator('.crumb.current')).toHaveText('phone');
    await webDialog(page).getByRole('button', { name: /select this folder/i }).tap();
    await collectionRow(page, 'phone').tap();
    await sidebarItem(page, 'echo-get').tap();
    // Picking a request closes the drawer.
    await expect(page.locator('html')).not.toHaveClass(/bw-drawer-open/);

    await page.getByTestId('send-arrow-icon').tap();
    await expect(page.getByTestId('response-status-code')).toContainText('200');
    const req = await page.getByTestId('request-pane').boundingBox();
    const res = await page.getByTestId('response-pane').boundingBox();
    expect(res.y).toBeGreaterThanOrEqual(req.y + req.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // The drawer did not touch Bruno's own collapsed setting, which other devices share.
    expect(await toggle.getAttribute('aria-label')).toBe(collapsedLabel);
  });
  test('full interface: row menus need no hover, dialogs fit the screen, tables scroll instead of squeezing', async ({ page, server, echo }) => {
    const srv = await server();
    writeCollection(path.join(srv.workspace, 'phone'), 'phone', [{ name: 'echo-get', url: `${echo.url}/phone?a=1` }]);
    await openApp(page, srv);
    await fullInterface(page);
    await page.getByTestId('toggle-sidebar-button').tap();
    await page.getByTestId('collections-header-add-menu').tap();
    await page.locator('.tippy-box .dropdown-item').filter({ hasText: /open collection/i }).first().tap();
    await webDialog(page).getByRole('option', { name: 'phone' }).tap();
    await webDialog(page).getByRole('button', { name: /select this folder/i }).tap();
    await collectionRow(page, 'phone').tap();

    // The request's "…" menu is there without hovering, and its dialog fits a 390 px screen.
    const row = page.locator('aside .collection-item-name').filter({ hasText: 'echo-get' });
    await expect(row.locator('.menu-icon')).toBeVisible();
    await row.locator('.menu-icon').tap();
    await page.locator('.tippy-box .dropdown-item').filter({ hasText: /generate code/i }).first().tap();
    const card = page.locator('.bruno-modal-card');
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();

    // The params table keeps readable columns and scrolls sideways inside its box.
    // (Picking a menu item closed the drawer.)
    await expect(page.locator('html')).not.toHaveClass(/bw-drawer-open/);
    await page.getByTestId('toggle-sidebar-button').tap();
    await row.tap();
    const table = page.locator('section.request-pane .table-container').first();
    await expect(table).toBeVisible();
    expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('full interface: Share Collection\'s format cards fit the dialog', async ({ page, server }) => {
    const srv = await server();
    writeCollection(path.join(srv.workspace, 'phone'), 'phone', [{ name: 'echo-get', url: 'http://127.0.0.1:9/x' }]);
    await openApp(page, srv);
    await fullInterface(page);
    await page.getByTestId('toggle-sidebar-button').tap();
    await openCollectionViaDialog(page, 'phone');
    await collectionRow(page, 'phone').tap();
    if (await page.locator('html.bw-drawer-open').count()) await page.getByTestId('toggle-sidebar-button').tap();
    await page.getByText('Share Collection', { exact: true }).tap();

    const content = page.locator('.bruno-modal-content');
    await expect(content.locator('.format-card').first()).toBeVisible();
    const fits = await content.evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return el.scrollWidth <= el.clientWidth
        && [...el.querySelectorAll('.format-card, .other-format-card')].every((c) => c.getBoundingClientRect().right <= right);
    });
    expect(fits).toBe(true);
  });

  test('an error event with no error object leaves the app alone; a real error\'s crash page shows its message; the server log gets both', async ({ page, server }) => {
    const srv = await server();
    await openApp(page, srv);
    const crashPage = page.getByText('Oops! Something went wrong');

    // What Safari reports for a browser extension's error: a message and no Error.
    await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' })));
    await expect(page.getByTestId('bw-phone')).toBeVisible();
    await fullInterface(page);
    await page.getByTestId('toggle-sidebar-button').tap();
    await expect(page.locator('html')).toHaveClass(/bw-drawer-open/);
    await expect(crashPage).toHaveCount(0);
    await expect.poll(() => srv.log()).toContain('client error (ignored)');
    expect(srv.log()).toContain('Script error.');

    // A call the server refuses by its settings, logged the way Bruno does: expected, not reported.
    await page.evaluate(() => window.ipcRenderer.invoke('terminal:list-sessions').catch((e) => console.error(e)));

    // React passes an error its boundaries catch to console.error.
    await page.evaluate(() => console.error(new Error('caught by a boundary')));
    await expect.poll(() => srv.log()).toMatch(/client console\.error at .*: caught by a boundary/);

    await page.evaluate(() => setTimeout(() => { throw new Error('a real failure'); }));
    await expect(crashPage).toBeVisible();
    await expect.poll(() => srv.log()).toMatch(/client error at .*: a real failure/);
    expect(srv.log()).not.toContain('on this Bruno Web server');
    const message = page.getByText('a real failure', { exact: true });
    await message.scrollIntoViewIfNeeded();
    const box = await message.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.width).toBeGreaterThan(50);
  });
});
