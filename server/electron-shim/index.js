/**
 * Stand-in for the `electron` module so the unmodified Bruno main-process code
 * can run on plain Node.
 *
 * Anything that needs the browser (dialogs, opening links, the OAuth window) is
 * forwarded to the active page through the hub (server/session.js), which is
 * attached with `setHub()` once the HTTP server is up. Until then such calls
 * fail loudly instead of hanging.
 *
 * Accessing an API that is not implemented here is recorded (see
 * `getMissingApis()`), logged once, and surfaced in /bruno-web/selfcheck.
 */
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

const missing = new Set();
const noteMissing = (name) => {
  if (missing.has(name)) return;
  missing.add(name);
  console.warn(`[bruno-web] electron shim: unimplemented API accessed: ${name}`);
};

// Wrap an object so reads of unknown properties are recorded rather than
// silently returning undefined.
const tracked = (name, target) => new Proxy(target, {
  get(obj, prop, receiver) {
    if (typeof prop === 'symbol' || prop in obj || prop === 'then' || prop === 'toJSON') {
      return Reflect.get(obj, prop, receiver);
    }
    noteMissing(`${name}.${String(prop)}`);
    return undefined;
  }
});

let hub = null;
const setHub = (h) => {
  hub = h;
};
const requireHub = (what) => {
  if (!hub) throw new Error(`bruno-web: ${what} is not available before the server has started`);
  return hub;
};

// ---------------------------------------------------------------------------
// ipcMain

class IpcMain extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this._handlers = new Map();
  }

  handle(channel, listener) {
    if (this._handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    this._handlers.set(channel, listener);
  }

  handleOnce(channel, listener) {
    this.handle(channel, (...args) => {
      this._handlers.delete(channel);
      return listener(...args);
    });
  }

  removeHandler(channel) {
    this._handlers.delete(channel);
  }

  getHandler(channel) {
    return this._handlers.get(channel);
  }

  handlerChannels() {
    return [...this._handlers.keys()];
  }
}

const ipcMain = new IpcMain();

// ---------------------------------------------------------------------------
// BrowserWindow / webContents

let nextWindowId = 1;
const windows = new Set();

class WebContents extends EventEmitter {
  constructor(win) {
    super();
    this.setMaxListeners(0);
    this.id = win.id;
    this._win = win;
    this._zoomLevel = 0;
    this.session = win._session;
  }

  send(channel, ...args) {
    if (this._win._kind === 'main') {
      // Same round trip upstream applies in index.js (did-finish-load wrapper),
      // so events carry exactly what the desktop renderer would receive.
      const plain = args.map(safeJsonRoundTrip);
      if (hub) hub.pushEvent(channel, plain);
    }
  }

  isDestroyed() {
    return this._win._destroyed;
  }

  getZoomLevel() {
    return this._zoomLevel;
  }

  setZoomLevel(level) {
    this._zoomLevel = level;
    if (this._win._kind === 'main' && hub) hub.notify('zoom', { level });
  }

  getURL() {
    return this._win._url || '';
  }

  toggleDevTools() {}
  openDevTools() {}
  closeDevTools() {}
  setWindowOpenHandler() {}
  reload() {
    if (this._win._kind === 'main' && hub) hub.notify('reload', {});
  }

  executeJavaScript() {
    return Promise.reject(new Error('executeJavaScript is not supported in Bruno Web'));
  }
}

class BrowserWindow extends EventEmitter {
  constructor(options = {}, kind) {
    super();
    this.setMaxListeners(0);
    this.id = nextWindowId++;
    this._kind = kind || 'aux';
    this._options = options;
    this._destroyed = false;
    this._url = '';
    const partition = options.webPreferences && options.webPreferences.partition;
    this._session = partition ? session.fromPartition(partition) : session.defaultSession;
    this.webContents = new WebContents(this);
    windows.add(this);
    if (this._kind === 'aux') {
      // Any window other than the main one is an auth popup (the only such use
      // upstream is authorizeUserInWindow); it is driven by the page.
      this._auth = true;
    }
  }

  static getAllWindows() {
    return [...windows].filter((w) => !w._destroyed);
  }

  static getFocusedWindow() {
    return mainWindow;
  }

  static fromWebContents(wc) {
    return [...windows].find((w) => w.webContents === wc) || null;
  }

  static fromId(id) {
    return [...windows].find((w) => w.id === id) || null;
  }

  async loadURL(url) {
    this._url = url;
    if (this._kind === 'main') return;
    const h = requireHub('Opening an authorization window');
    // Resolves when the page reports the window as closed; navigation events are
    // delivered through deliverAuthNavigation() in the meantime.
    h.openAuthWindow(this, url);
    this.emit('ready-to-show');
  }

  loadFile() {
    return Promise.resolve();
  }

  // Called by the hub when the page (popup, pasted URL or our callback route)
  // tells us where the auth window ended up.
  deliverNavigation(url) {
    if (this._destroyed) return;
    this._url = url;
    const event = { preventDefault() {}, defaultPrevented: false };
    this.webContents.emit('did-start-navigation', event, url, false, true);
    this.webContents.emit('will-redirect', event, url);
    this.webContents.emit('did-navigate', event, url);
  }

  close() {
    if (this._destroyed) return;
    if (this._kind === 'main') return;
    this.emit('close', { preventDefault() {} });
    this._destroyed = true;
    windows.delete(this);
    if (hub && this._auth) hub.closeAuthWindow(this);
    this.emit('closed');
  }

  destroy() {
    this.close();
  }

  show() {}
  hide() {}
  focus() {}
  blur() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  restore() {}
  isMinimized() { return false; }
  isMaximized() { return false; }
  isFullScreen() { return false; }
  setFullScreen() {}
  isVisible() { return true; }
  isFocused() { return true; }
  isDestroyed() { return this._destroyed; }
  getBounds() { return { x: 0, y: 0, width: 1440, height: 900 }; }
  setBounds() {}
  getSize() { return [1440, 900]; }
  setTitle() {}
  setMenu() {}
  setMenuBarVisibility() {}
  setProgressBar() {}
}

// ---------------------------------------------------------------------------
// session / protocol

const protocolHandlers = new Map(); // `${partition}|${scheme}` -> handler

const makeWebRequest = () => ({
  onBeforeRequest() {},
  onBeforeSendHeaders() {},
  onSendHeaders() {},
  onHeadersReceived() {},
  onResponseStarted() {},
  onBeforeRedirect() {},
  onCompleted() {},
  onErrorOccurred() {}
});

const sessions = new Map();
const makeSession = (partition) => tracked(`session(${partition})`, {
  partition,
  webRequest: makeWebRequest(),
  protocol: {
    handle(scheme, handler) {
      protocolHandlers.set(`${partition}|${scheme}`, handler);
    },
    unhandle(scheme) {
      protocolHandlers.delete(`${partition}|${scheme}`);
    },
    isProtocolHandled(scheme) {
      return protocolHandlers.has(`${partition}|${scheme}`);
    }
  },
  cookies: {
    get: async () => [],
    set: async () => {},
    remove: async () => {},
    flushStore: async () => {}
  },
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  setCertificateVerifyProc() {},
  setProxy: async () => {},
  resolveProxy: async () => 'DIRECT',
  clearStorageData: async () => {},
  clearCache: async () => {},
  clearAuthCache: async () => {},
  getUserAgent: () => `Bruno-Web/${appVersion()}`,
  setUserAgent() {}
});

const session = {
  fromPartition(partition) {
    const key = partition || 'default';
    if (!sessions.has(key)) sessions.set(key, makeSession(key));
    return sessions.get(key);
  },
  get defaultSession() {
    return session.fromPartition('default');
  }
};

const protocol = tracked('protocol', {
  registerSchemesAsPrivileged() {},
  handle(scheme, handler) {
    protocolHandlers.set(`default|${scheme}`, handler);
  },
  unhandle(scheme) {
    protocolHandlers.delete(`default|${scheme}`);
  },
  isProtocolHandled(scheme) {
    return protocolHandlers.has(`default|${scheme}`);
  },
  registerFileProtocol() {},
  registerStringProtocol() {}
});

const getProtocolHandler = (scheme) => {
  for (const [key, handler] of protocolHandlers) {
    if (key.endsWith(`|${scheme}`)) return handler;
  }
  return null;
};

// ---------------------------------------------------------------------------
// app

let cachedVersion = null;
const appVersion = () => {
  if (!cachedVersion) {
    try {
      cachedVersion = require(path.join(config.upstreamDir, 'packages/bruno-electron/package.json')).version;
    } catch (e) {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
};

const appPaths = () => ({
  userData: config.userDataDir,
  appData: config.userDataDir,
  sessionData: config.userDataDir,
  documents: config.documentsDir,
  home: config.documentsDir,
  desktop: config.documentsDir,
  downloads: config.downloadsDir,
  temp: config.tmpDir,
  logs: path.join(config.userDataDir, 'logs'),
  crashDumps: path.join(config.userDataDir, 'crashes'),
  exe: process.execPath,
  module: process.execPath
});

const startedAt = Date.now();

class App extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.isPackaged = true;
    this.commandLine = { appendSwitch() {}, appendArgument() {}, hasSwitch: () => false, getSwitchValue: () => '' };
    this.dock = undefined;
    this._overrides = {};
  }

  getPath(name) {
    if (this._overrides[name]) return this._overrides[name];
    const p = appPaths()[name];
    if (!p) throw new Error(`Failed to get '${name}' path`);
    return p;
  }

  setPath(name, value) {
    this._overrides[name] = value;
  }

  getVersion() { return appVersion(); }
  getName() { return 'Bruno'; }
  setName() {}
  getAppPath() { return path.join(config.upstreamDir, 'packages/bruno-electron'); }
  getLocale() { return 'en-US'; }
  getSystemLocale() { return 'en-US'; }
  getPreferredSystemLanguages() { return ['en-US']; }
  isReady() { return true; }
  whenReady() { return Promise.resolve(); }
  requestSingleInstanceLock() { return true; }
  releaseSingleInstanceLock() {}
  setAsDefaultProtocolClient() { return true; }
  removeAsDefaultProtocolClient() { return true; }
  addRecentDocument() {}
  clearRecentDocuments() {}
  focus() {}
  quit() { this.emit('before-quit', { preventDefault() {} }); }
  exit(code) { process.exit(code || 0); }
  relaunch() {}

  getAppMetrics() {
    const usage = process.cpuUsage();
    const mem = process.memoryUsage();
    return [{
      pid: process.pid,
      type: 'Browser',
      creationTime: startedAt,
      cpu: {
        percentCPUUsage: 0,
        cumulativeCPUUsage: (usage.user + usage.system) / 1e6,
        idleWakeupsPerSecond: 0
      },
      memory: {
        workingSetSize: Math.round(mem.rss / 1024),
        peakWorkingSetSize: Math.round(mem.rss / 1024)
      }
    }];
  }
}

const app = new App();

// ---------------------------------------------------------------------------
// dialog — answered by the active page's server-side file browser

const dialog = tracked('dialog', {
  async showOpenDialog(win, options) {
    if (!(win instanceof BrowserWindow)) options = win;
    return requireHub('File dialogs').openDialog(options || {});
  },
  async showSaveDialog(win, options) {
    if (!(win instanceof BrowserWindow)) options = win;
    return requireHub('File dialogs').saveDialog(options || {});
  },
  async showMessageBox(win, options) {
    if (!(win instanceof BrowserWindow)) options = win;
    return requireHub('Message boxes').messageBox(options || {});
  },
  showErrorBox(title, content) {
    if (hub) hub.notify('toast', { level: 'error', title, message: content });
    console.error(`[dialog] ${title}: ${content}`);
  },
  showOpenDialogSync() {
    noteMissing('dialog.showOpenDialogSync');
    return undefined;
  },
  showSaveDialogSync() {
    noteMissing('dialog.showSaveDialogSync');
    return undefined;
  },
  showMessageBoxSync() {
    noteMissing('dialog.showMessageBoxSync');
    return 0;
  }
});

// ---------------------------------------------------------------------------
// shell

const shell = tracked('shell', {
  async openExternal(url) {
    requireHub('Opening links').openExternal(String(url));
  },
  async openPath(p) {
    if (hub) hub.notify('toast', { level: 'info', title: 'Server path', message: String(p) });
    return '';
  },
  showItemInFolder(p) {
    if (hub) hub.notify('toast', { level: 'info', title: 'Server path', message: String(p) });
  },
  async trashItem(p) {
    // No desktop trash on a server: move it under the data dir instead of deleting.
    const dest = path.join(config.trashDir, `${Date.now()}-${path.basename(p)}`);
    await fs.promises.mkdir(config.trashDir, { recursive: true });
    await fs.promises.rename(p, dest);
  },
  beep() {}
});

// ---------------------------------------------------------------------------
// safeStorage — AES-256-GCM with a per-instance master key

let masterKey = null;
const getMasterKey = () => {
  if (masterKey) return masterKey;
  if (config.secretKey) {
    masterKey = crypto.createHash('sha256').update(config.secretKey).digest();
    return masterKey;
  }
  const keyFile = path.join(config.userDataDir, '.bruno-web-master-key');
  try {
    masterKey = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    masterKey = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, masterKey.toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  if (masterKey.length !== 32) throw new Error(`Invalid master key in ${keyFile}`);
  return masterKey;
};

const SAFE_STORAGE_MAGIC = Buffer.from('bw1');

const safeStorage = tracked('safeStorage', {
  isEncryptionAvailable() {
    return true;
  },
  isAsyncEncryptionAvailable() {
    return Promise.resolve(true);
  },
  getSelectedStorageBackend() {
    return 'bruno_web_aes_gcm';
  },
  encryptString(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
    const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return Buffer.concat([SAFE_STORAGE_MAGIC, iv, cipher.getAuthTag(), body]);
  },
  decryptString(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 31 || !buf.subarray(0, 3).equals(SAFE_STORAGE_MAGIC)) {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    }
    const iv = buf.subarray(3, 15);
    const tag = buf.subarray(15, 31);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(31)), decipher.final()]).toString('utf8');
  }
});

// ---------------------------------------------------------------------------
// Everything else used upstream only for desktop chrome

class NativeTheme extends EventEmitter {
  constructor() {
    super();
    this._source = 'system';
    this._pageDark = false;
  }
  get themeSource() { return this._source; }
  set themeSource(v) { this._source = v; this.emit('updated'); }
  get shouldUseDarkColors() {
    if (this._source === 'dark') return true;
    if (this._source === 'light') return false;
    return this._pageDark;
  }
  setPageDark(dark) {
    if (this._pageDark === !!dark) return;
    this._pageDark = !!dark;
    this.emit('updated');
  }
}
const nativeTheme = new NativeTheme();

const display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaSize: { width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1
};
const screen = tracked('screen', {
  getPrimaryDisplay: () => display,
  getAllDisplays: () => [display],
  getDisplayMatching: () => display,
  getDisplayNearestPoint: () => display,
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on() {},
  removeListener() {}
});

const Menu = {
  buildFromTemplate: () => ({ popup() {}, closePopup() {}, items: [] }),
  setApplicationMenu() {},
  getApplicationMenu: () => null
};

const globalShortcut = { register() { return true; }, unregister() {}, unregisterAll() {}, isRegistered: () => false };
const webUtils = { getPathForFile: () => '' };

let clipboardText = '';
const clipboard = {
  writeText(text) { clipboardText = String(text); if (hub) hub.notify('clipboard', { text: clipboardText }); },
  readText() { return clipboardText; }
};

// ---------------------------------------------------------------------------
// The main window: one per process, id 1 (authorizeUserInWindow relies on that).

const mainWindow = new BrowserWindow({}, 'main');
mainWindow.webContents.getType = () => 'window';

// Guest pages: the <webview> stand-ins on the active page, as reported by it.
const guestContents = (guest) => ({
  id: guest.id + 1000,
  getType: () => 'webview',
  getURL: () => guest.url,
  isDestroyed: () => !hub || !hub.guests.has(guest.id),
  executeJavaScript: (code) => requireHub('Guest pages').execInGuest(guest.id, code)
});

const webContents = tracked('webContents', {
  getAllWebContents: () => [mainWindow.webContents, ...(hub ? hub.listGuests().map(guestContents) : [])],
  getFocusedWebContents: () => mainWindow.webContents,
  fromId: (id) => webContents.getAllWebContents().find((wc) => wc.id === id) || null
});

let upstreamJson = null;
const safeJsonRoundTrip = (value) => {
  if (!upstreamJson) upstreamJson = require(path.join(config.upstreamDir, 'packages/bruno-electron/src/utils/common'));
  return upstreamJson.safeParseJSON(upstreamJson.safeStringifyJSON(value));
};

const electron = tracked('electron', {
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  session,
  protocol,
  safeStorage,
  nativeTheme,
  screen,
  Menu,
  MenuItem: class MenuItem {},
  globalShortcut,
  webUtils,
  webContents,
  clipboard,
  // Renderer-only modules: undefined in the main process, which is exactly what
  // electron-store checks to decide it is running in main.
  ipcRenderer: undefined,
  contextBridge: undefined
});

module.exports = electron;
module.exports.__bruno_web__ = {
  setHub,
  getHub: () => hub,
  mainWindow,
  ipcMain,
  nativeTheme,
  getProtocolHandler,
  getMissingApis: () => [...missing].sort(),
  safeJsonRoundTrip
};
