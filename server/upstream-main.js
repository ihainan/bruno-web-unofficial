/**
 * Boots the upstream main process (packages/bruno-electron/src) without
 * Electron. Mirrors the window-independent parts of upstream's index.js
 * `app.on('ready')` block, in the same order; keep the two in sync when the
 * upstream baseline moves (scripts/check-upstream.js flags new register* calls).
 */
const path = require('node:path');
const config = require('./config');

const src = path.join(config.upstreamDir, 'packages', 'bruno-electron', 'src');
const up = (p) => require(path.join(src, p));

// bruno-js decides at load time whether it runs in the app or the CLI by
// looking for process.versions.electron, and in the CLI it hides the QuickJS
// engine's abort diagnostics (stderr is the user's screen there). Our stderr
// is a server log, like the app's. Declare Electron only while that module
// loads: other packages (commander, open) change behaviour on the same check.
const loadSandboxAsAppHost = () => {
  const jsSrc = path.dirname(require.resolve('@usebruno/js', { paths: [src] }));
  const versions = process.versions;
  Object.defineProperty(process, 'versions', { value: { ...versions, electron: 'bruno-web' }, configurable: true, writable: false, enumerable: true });
  try {
    require(path.join(jsSrc, 'sandbox', 'quickjs'));
  } finally {
    Object.defineProperty(process, 'versions', { value: versions, configurable: true, writable: false, enumerable: true });
  }
};

const start = async () => {
  const electron = require('electron');
  const { mainWindow, ipcMain } = electron.__bruno_web__;

  const { initializeShellEnv, waitForShellEnv } = up('store/shell-env-state');
  const { percentageToZoomLevel } = require(require.resolve('@usebruno/common', { paths: [src] }));
  const registerNetworkIpc = up('ipc/network');
  const registerCollectionsIpc = up('ipc/collection');
  const { registerYmlMigrationIpc } = up('ipc/yml-migration');
  const registerFilesystemIpc = up('ipc/filesystem');
  const registerPreferencesIpc = up('ipc/preferences');
  const registerSnapshotIpc = up('ipc/snapshot');
  const registerSystemMonitorIpc = up('ipc/system-monitor');
  const registerWorkspaceIpc = up('ipc/workspace');
  const registerApiSpecIpc = up('ipc/apiSpec');
  const registerGitIpc = up('ipc/git');
  const registerOpenAPISyncIpc = up('ipc/openapi-sync');
  const registerMockServerIpc = up('ipc/mock-server');
  const registerAiIpc = up('ipc/ai');
  const registerAiAutocompleteIpc = up('ipc/ai/autocomplete');
  const { registerMountIpc } = up('ipc/mount');
  const { registerSqliteIpc } = up('ipc/sqlite');
  const sqliteService = up('services/sqlite');
  const { clearAllRunnerResponses } = up('services/runner-exchange');
  const { registerWsdlIpc } = up('ipc/wsdl');
  const collectionWatcher = up('app/collection-watcher');
  const WorkspaceWatcher = up('app/workspace-watcher');
  const ApiSpecWatcher = up('app/apiSpecsWatcher');
  const { preferencesUtil, getPreferences, savePreferences } = up('store/preferences');
  const { globalEnvironmentsManager } = up('store/workspace-environments');
  const registerNotificationsIpc = up('ipc/notifications');
  const registerGlobalEnvironmentsIpc = up('ipc/global-environments');
  const registerAppDocumentIpc = up('ipc/app-document');
  const AppDocuments = up('app/app-documents');
  const TerminalManager = up('ipc/terminal');
  const { getDomainsWithCookies } = up('utils/cookies');
  const { cookiesStore } = up('store/cookies');
  const SystemMonitor = up('app/system-monitor');
  const { getIsRunningInRosetta } = up('utils/arch');

  const systemMonitor = new SystemMonitor();
  const terminalManager = new TerminalManager();
  const workspaceWatcher = new WorkspaceWatcher();
  const apiSpecWatcher = new ApiSpecWatcher();
  const appDocuments = new AppDocuments();
  AppDocuments.registerScheme();

  initializeShellEnv();

  const { fetchSystemProxy } = up('store/system-proxy');
  waitForShellEnv()
    .catch((err) => console.warn('Shell env init failed:', err))
    .finally(() => {
      // The login shell may export our settings too.
      config.scrubEnvironment();
      fetchSystemProxy().catch((err) => console.warn('Failed to initialize system proxy cache:', err));
    });

  // Window chrome: the page has no OS window, so these are no-ops or are
  // forwarded to the page.
  ipcMain.on('renderer:window-minimize', () => {});
  ipcMain.on('renderer:window-maximize', () => {});
  ipcMain.on('renderer:window-close', () => {});
  ipcMain.handle('renderer:window-is-maximized', () => false);
  ipcMain.handle('renderer:window-is-fullscreen', () => false);
  ipcMain.handle('renderer:open-preferences', () => {
    ipcMain.emit('main:open-preferences');
  });
  ipcMain.handle('renderer:toggle-devtools', () => {});
  ipcMain.handle('renderer:toggle-fullscreen', () => {});
  ipcMain.handle('renderer:open-docs', () => {
    ipcMain.emit('main:open-docs');
  });
  ipcMain.on('main:open-docs', () => {
    electron.shell.openExternal('https://docs.usebruno.com');
  });
  ipcMain.handle('renderer:open-about', () => {
    electron.shell.openExternal('https://www.usebruno.com');
  });

  const saveZoom = async (percentage) => {
    const clamped = Math.max(50, Math.min(150, percentage));
    const prefs = getPreferences();
    prefs.display = prefs.display || {};
    prefs.display.zoomPercentage = clamped;
    await savePreferences(prefs);
    mainWindow.webContents.send('main:load-preferences', prefs);
  };
  const zoomTo = (percentage) => {
    mainWindow.webContents.setZoomLevel(percentageToZoomLevel(percentage));
    return saveZoom(percentage);
  };
  const zoomBy = (inc) => zoomTo(Math.min(Math.max(preferencesUtil.getZoomPercentage() + inc, 50), 150));
  ipcMain.handle('renderer:reset-zoom', () => zoomTo(100));
  ipcMain.handle('renderer:zoom-in', () => zoomBy(10));
  ipcMain.handle('renderer:zoom-out', () => zoomBy(-10));
  ipcMain.handle('renderer:set-zoom-level', (event, zoomLevel) => {
    mainWindow.webContents.setZoomLevel(zoomLevel);
  });

  // Upstream's did-finish-load handler: cookie list + app-loaded. The cookie jar
  // is loaded from disk only for the first page; later pages (reloads) must not
  // re-read it, or changes still waiting for the debounced save would be undone.
  let cookiesInitialized = false;
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      if (!cookiesInitialized) {
        cookiesStore.initializeCookies();
        cookiesInitialized = true;
      }
      const cookiesList = await getDomainsWithCookies();
      mainWindow.webContents.send('main:cookies-update', cookiesList);
    } catch (err) {
      console.error('Failed to load cookies for renderer', err);
    }
    mainWindow.webContents.send('main:app-loaded', { isRunningInRosetta: getIsRunningInRosetta() });
    // Upstream applies the saved zoom when its window is first shown.
    const zoom = preferencesUtil.getZoomPercentage();
    if (zoom && zoom !== 100) mainWindow.webContents.setZoomLevel(percentageToZoomLevel(zoom));
  });

  registerNetworkIpc(mainWindow);
  registerGlobalEnvironmentsIpc(mainWindow, globalEnvironmentsManager);
  registerCollectionsIpc(mainWindow, collectionWatcher);
  registerYmlMigrationIpc(mainWindow, collectionWatcher);
  registerPreferencesIpc(mainWindow, collectionWatcher);
  registerSnapshotIpc();
  registerWorkspaceIpc(mainWindow, workspaceWatcher);
  registerApiSpecIpc(mainWindow, apiSpecWatcher);
  registerNotificationsIpc(mainWindow, collectionWatcher);
  registerFilesystemIpc(mainWindow);
  registerSystemMonitorIpc(mainWindow, systemMonitor);
  registerGitIpc(mainWindow);
  registerOpenAPISyncIpc(mainWindow);
  registerMockServerIpc(mainWindow);
  registerAiIpc(mainWindow);
  registerAiAutocompleteIpc(mainWindow);
  registerMountIpc();
  sqliteService.openDatabase();
  clearAllRunnerResponses().catch((err) => console.warn('[runner] failed to clear stored responses', err));
  registerSqliteIpc();
  appDocuments.handleProtocol();
  registerAppDocumentIpc(appDocuments, mainWindow);
  registerWsdlIpc();

  ipcMain.handle('main:cache-clear', async () => {
    ipcMain.emit('internal:snapshot:reset');
  });

  // Same as upstream's index.js: closing the main window starts the
  // unsaved-changes flow instead of closing.
  mainWindow.on('close', () => {
    ipcMain.emit('main:start-quit-flow');
  });

  // Upstream exits the process here ("Force quit" on the crash screen). For a
  // server that would take Bruno down for its user; reloading the page is the
  // browser's equivalent of restarting the app.
  ipcMain.removeHandler('main:force-quit');
  ipcMain.handle('main:force-quit', () => {
    const hub = electron.__bruno_web__.getHub();
    if (hub) hub.notify('reload', {});
  });

  const closeAllWatchers = () => Promise.allSettled([
    collectionWatcher.closeAllWatchers(),
    workspaceWatcher.closeAllWatchers(),
    apiSpecWatcher.closeAllWatchers()
  ]);

  // Same order as upstream's before-quit handler.
  const shutdown = async () => {
    try {
      await Promise.race([closeAllWatchers(), new Promise((r) => setTimeout(r, 2000))]);
    } catch (e) {}
    try { await up('ipc/mount').shutdown({ force: true }); } catch (e) {}
    try { await clearAllRunnerResponses(); } catch (e) {}
    try { await sqliteService.reclaimDiskSpace(); } catch (e) {}
    try { sqliteService.shutdown(); } catch (e) {}
    try { cookiesStore.saveCookieJar(true); } catch (e) { console.warn('Failed to flush cookies on quit', e); }
    systemMonitor.stop();
    try { terminalManager.killAll(); } catch (e) {}
    // gRPC connections are closed from a window-all-closed listener.
    try { electron.app.emit('window-all-closed'); } catch (e) {}
  };

  return { shutdown };
};

module.exports = { start, loadSandboxAsAppHost, upstreamSrc: src };
