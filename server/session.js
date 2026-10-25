/**
 * The hub between the page and the upstream main-process code.
 *
 * Pages. Exactly one page is active at a time; a new page takes over and the
 * old one is told so. A new page is the desktop app's renderer reload: the
 * main process keeps its state and upstream re-sends what the renderer needs
 * when it calls `renderer:ready` (the mount service has an explicit reload
 * path). `did-finish-load` fires once the page reports its load event, as in
 * Electron, so the renderer's listeners exist by then.
 *
 * Delivery. Every server→page message carries a sequence number and stays in
 * a replay buffer until the page acknowledges it. Every page→server message
 * carries an increasing id; the server remembers the highest id it received.
 * After a reconnect with the same page id the server replays what the page
 * has not acknowledged and tells the page the highest id it received, so the
 * page resends exactly the messages that never arrived — nothing is lost and
 * nothing runs twice. If that cannot be guaranteed (page id unknown, outside
 * the resume window, buffer overflowed) the page must reload.
 *
 * Reverse RPC. Calls the main process makes into the page (file dialogs,
 * opening links, OAuth windows) are answered by the active page.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { encode, decode, formatInvokeError } = require('../web/codec');
const config = require('./config');
const { exportHooks } = require('./export-hooks');

const invokeContext = new AsyncLocalStorage();

class Hub {
  constructor({ ipcMain, mainWindow, policy, downloads }) {
    this.ipcMain = ipcMain;
    this.mainWindow = mainWindow;
    this.policy = policy;
    this.downloads = downloads;

    this.ws = null;
    this.pageId = null;
    this.lastSeenAt = 0;

    this.seq = 0; // last sequence number sent
    this.evictedSeq = 0; // highest seq dropped from the buffer
    this.abandonTimer = null;
    this.ackedSeq = 0;
    this.buffer = []; // { seq, text } not yet acknowledged
    this.bufferBytes = 0;
    this.rx = 0; // highest page message id received
    // Message ids restart with every page, so a result computed for a page that
    // has since been replaced must not reach the new one (it would resolve an
    // unrelated request with the same id).
    this.generation = 0;

    this.rpcSeq = 0;
    this.pendingRpcs = new Map(); // id -> { resolve, reject, method, cancelValue }
    this.authWindows = new Map(); // id -> BrowserWindow
    this.guests = new Map(); // <webview> id on the page -> { url }
    this.pageLoaded = false;
  }

  // ------------------------------------------------------------------ connections

  attach(ws, { pageId, lastSeq }) {
    // Resumable if everything after lastSeq is still in the buffer.
    const resumable = this.pageId === pageId
      && Date.now() - this.lastSeenAt <= config.resumeWindowMs
      && lastSeq >= this.evictedSeq
      && lastSeq <= this.seq
      && lastSeq >= this.ackedSeq;

    if (this.ws && this.ws !== ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.send(encode({ t: 'taken-over' }));
        old.close(4001, 'taken over');
      } catch (e) {}
    }

    this.ws = ws;
    this.lastSeenAt = Date.now();

    if (resumable) {
      this.ack(lastSeq);
      ws.send(encode({ t: 'hello', resumed: true, rx: this.rx }));
      for (const entry of this.buffer) ws.send(entry.text);
    } else {
      this.startNewPage(pageId);
      ws.send(encode({ t: 'hello', resumed: false, rx: 0 }));
    }

    clearTimeout(this.abandonTimer);
    ws.on('message', (data) => {
      try {
        this.onMessage(ws, data);
      } catch (err) {
        console.error('[bruno-web] failed to handle a page message', err);
        try { ws.close(1011, 'internal error'); } catch (e) {}
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.lastSeenAt = Date.now();
      // If the page does not come back within the resume window, nobody will
      // answer what we asked it; end those calls instead of leaving them hanging.
      clearTimeout(this.abandonTimer);
      this.abandonTimer = setTimeout(() => {
        if (!this.ws) this.cancelPageWork();
      }, config.resumeWindowMs + 1000);
      this.abandonTimer.unref();
    });
  }

  startNewPage(pageId) {
    this.cancelPageWork();
    this.generation += 1;
    this.pageId = pageId;
    this.buffer = [];
    this.bufferBytes = 0;
    this.ackedSeq = this.seq;
    this.evictedSeq = this.seq;
    this.rx = 0;
    this.pageLoaded = false;
  }

  // Ends everything only a particular page could have completed.
  cancelPageWork() {
    for (const [id, pending] of this.pendingRpcs) {
      this.pendingRpcs.delete(id);
      pending.resolve(pending.cancelValue);
    }
    for (const win of [...this.authWindows.values()]) {
      try { win.close(); } catch (e) {}
    }
    this.authWindows.clear();
    this.guests.clear();
    // A system-browser OAuth flow would otherwise wait for a callback that the
    // page which started it can no longer use.
    try {
      const { cancelOAuth2AuthorizationRequest } = require(path.join(config.upstreamDir, 'packages/bruno-electron/src/utils/oauth2-protocol-handler'));
      cancelOAuth2AuthorizationRequest();
    } catch (e) {}
  }

  // ------------------------------------------------------------------ outbound

  deliver(msg) {
    msg.seq = ++this.seq;
    let text = encode(msg);
    if (text.length > config.maxResultBytes) {
      console.error(`[bruno-web] ${msg.t} ${msg.ch || msg.method || ''} is ${text.length} bytes, over the limit`);
      if (msg.t === 'result') {
        text = encode({
          t: 'result',
          seq: msg.seq,
          id: msg.id,
          ok: false,
          error: { message: formatInvokeError(msg.ch, `Error: Result too large for Bruno Web (${text.length} bytes)`) }
        });
      } else {
        if (msg.t === 'rpc') {
          const pending = this.pendingRpcs.get(msg.id);
          this.pendingRpcs.delete(msg.id);
          if (pending) pending.reject(new Error(`Request to the page too large (${text.length} bytes)`));
        }
        // The page would silently miss state it relies on: have it reload.
        text = encode({ t: 'reload-required', seq: msg.seq, reason: 'message too large' });
      }
    }
    this.buffer.push({ seq: msg.seq, text });
    this.bufferBytes += text.length;
    while (this.buffer.length > config.replayMaxEvents || this.bufferBytes > config.replayMaxBytes) {
      const evicted = this.buffer.shift();
      this.bufferBytes -= evicted.text.length;
      // A page that has not received this can no longer catch up by replay.
      this.evictedSeq = Math.max(this.evictedSeq, evicted.seq);
    }
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(text);
      // A page that does not keep up must not make us buffer without bound;
      // closing makes it reconnect and catch up from the replay buffer (or reload).
      if (this.ws.bufferedAmount > config.maxSendBacklogBytes) {
        console.warn(`[bruno-web] page is ${this.ws.bufferedAmount} bytes behind; dropping the connection`);
        this.ws.terminate();
      }
    }
  }

  pushEvent(channel, args) {
    this.deliver({ t: 'event', ch: channel, args });
  }

  notify(method, params) {
    this.deliver({ t: 'notify', method, params });
  }

  request(method, params, cancelValue) {
    if (!this.pageId) return Promise.resolve(cancelValue);
    const id = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      this.pendingRpcs.set(id, { resolve, reject, method, cancelValue });
      this.deliver({ t: 'rpc', id, method, params });
    });
  }

  ack(seq) {
    if (!(seq > this.ackedSeq)) return;
    this.ackedSeq = Math.min(seq, this.seq);
    while (this.buffer.length && this.buffer[0].seq <= this.ackedSeq) {
      this.bufferBytes -= this.buffer.shift().text.length;
    }
  }

  // ------------------------------------------------------------------ inbound

  onMessage(ws, data) {
    if (this.ws !== ws) return;
    let msg;
    try {
      msg = decode(data.toString());
    } catch (e) {
      console.error('[bruno-web] bad message from page', e.message);
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      console.error('[bruno-web] malformed message from page');
      return;
    }
    this.lastSeenAt = Date.now();

    // Control messages (no id, not subject to resend).
    switch (msg.t) {
      case 'ping':
        ws.send(encode({ t: 'pong', rx: this.rx }));
        return;
      case 'ack':
        this.ack(msg.seq);
        return;
      default:
        break;
    }

    // Everything else is numbered by the page and must arrive in order: drop
    // what we have already seen; on a gap, close so the page reconnects and
    // resends from the first id we are missing.
    if (!Number.isInteger(msg.id) || msg.id <= this.rx) return;
    if (msg.id !== this.rx + 1) {
      console.warn(`[bruno-web] page message ${msg.id} arrived before ${this.rx + 1}; reconnecting`);
      ws.close(4002, 'out of order');
      return;
    }
    this.rx = msg.id;

    switch (msg.t) {
      case 'invoke':
        return this.onInvoke(msg);
      case 'send':
        return this.onSend(msg);
      case 'rpc-result':
        return this.onRpcResult(msg);
      case 'page-loaded':
        if (!this.pageLoaded) {
          this.pageLoaded = true;
          this.mainWindow.webContents.emit('did-finish-load');
        }
        return;
      case 'theme':
        this.policy.onTheme(msg.dark);
        return;
      case 'webview':
        if (msg.op === 'set') this.guests.set(msg.guest, { url: String(msg.url || '') });
        else if (msg.op === 'remove') this.guests.delete(msg.guest);
        return;
      case 'auth-nav':
        this.deliverAuthNavigation(msg.window, msg.url);
        return;
      case 'auth-close': {
        const win = this.authWindows.get(msg.window);
        if (win) win.close();
        return;
      }
      default:
        console.warn(`[bruno-web] unknown message type from page: ${msg.t}`);
    }
  }

  makeEvent() {
    const wc = this.mainWindow.webContents;
    return {
      sender: wc,
      senderFrame: null,
      processId: process.pid,
      frameId: 0,
      returnValue: undefined,
      reply: (channel, ...args) => wc.send(channel, ...args)
    };
  }

  async onInvoke({ id, ch, args }) {
    const generation = this.generation;
    const deliverResult = (msg) => {
      if (this.generation === generation) this.deliver(msg);
    };
    const deliverError = (errorText) => deliverResult({
      t: 'result', id, ch, ok: false, error: { message: formatInvokeError(ch, errorText) }
    });

    const blocked = this.policy.checkChannel(ch);
    if (blocked) return deliverError(`Error: ${blocked}`);

    const handler = this.ipcMain.getHandler(ch);
    if (!handler) return deliverError(`Error: No handler registered for '${ch}'`);

    args = args || [];
    const hook = exportHooks[ch];
    const ctx = { channel: ch, after: [] };
    try {
      const before = hook ? await hook.before(args) : null;
      const value = await invokeContext.run(ctx, () => handler(this.makeEvent(), ...args));
      deliverResult({ t: 'result', id, ch, ok: true, value });
      if (hook) {
        ctx.after.push(async () => {
          if (this.generation !== generation) return;
          for (const file of await hook.after(args, value, before)) this.offerDownload(file.path, { keep: !file.temporary });
        });
      }
    } catch (err) {
      deliverError(String(err));
    } finally {
      for (const fn of ctx.after) {
        try { await fn(); } catch (e) { console.error('[bruno-web] post-invoke step failed', e); }
      }
    }
  }

  onSend({ ch, args }) {
    const blocked = this.policy.checkChannel(ch);
    if (blocked) {
      this.notify('toast', { level: 'error', message: blocked });
      return;
    }
    try {
      this.ipcMain.emit(ch, this.makeEvent(), ...(args || []));
    } catch (err) {
      console.error(`[bruno-web] listener for '${ch}' threw`, err);
    }
  }

  onRpcResult({ rpc, ok, value, error }) {
    const pending = this.pendingRpcs.get(rpc);
    if (!pending) return;
    this.pendingRpcs.delete(rpc);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(error && error.message ? error.message : `Page failed to handle ${pending.method}`));
  }

  // ------------------------------------------------------------------ used by the electron shim

  async openDialog(options) {
    const result = await this.request('dialog-open', {
      ...sanitizeDialogOptions(options),
      roots: this.policy.roots()
    }, { canceled: true, filePaths: [] });
    if (!result || result.canceled) return { canceled: true, filePaths: [] };
    const filePaths = [];
    for (const p of result.filePaths || []) {
      filePaths.push(await this.policy.resolveInsideRoots(p, { allowUploads: true }));
    }
    return { canceled: false, filePaths };
  }

  async saveDialog(options) {
    const result = await this.request('dialog-save', {
      ...sanitizeDialogOptions(options),
      roots: this.policy.roots()
    }, { canceled: true });
    if (!result || result.canceled) return { canceled: true, filePath: '' };

    if (result.mode === 'download') {
      const name = path.basename(result.fileName || path.basename(options.defaultPath || 'download'));
      const dir = path.join(config.downloadsDir, crypto.randomUUID());
      await fs.promises.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, name);
      this.scheduleDownload(filePath);
      return { canceled: false, filePath };
    }

    const filePath = await this.policy.resolveInsideRoots(result.filePath, { forWrite: true });
    return { canceled: false, filePath };
  }

  // Once the handler that asked for the save path has finished writing, hand
  // the file to the page as a browser download.
  scheduleDownload(filePath) {
    const offer = async () => {
      const stat = await waitForStableFile(filePath, 30000);
      if (!stat) {
        console.warn(`[bruno-web] nothing was written to ${filePath}; no download offered`);
        fs.rm(path.dirname(filePath), { recursive: true, force: true }, () => {});
        return;
      }
      this.offerDownload(filePath, { keep: false });
    };
    const ctx = invokeContext.getStore();
    if (ctx) ctx.after.push(offer);
    else setTimeout(() => offer().catch((e) => console.error(e)), 500);
  }

  offerDownload(filePath, { keep }) {
    const token = this.downloads.register(filePath, { keep });
    this.notify('download', { url: `/bruno-web/api/download/${token}`, name: path.basename(filePath) });
  }

  async messageBox(options) {
    const result = await this.request('message-box', {
      type: options.type,
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons || ['OK'],
      defaultId: options.defaultId,
      cancelId: options.cancelId,
      checkboxLabel: options.checkboxLabel,
      checkboxChecked: options.checkboxChecked
    }, { response: options.cancelId ?? 0, checkboxChecked: false });
    return { response: (result && result.response) ?? 0, checkboxChecked: !!(result && result.checkboxChecked) };
  }

  // Guest documents (<webview> on the page), for the shim's webContents module.
  listGuests() {
    return [...this.guests].map(([id, g]) => ({ id, url: g.url }));
  }

  execInGuest(id, code) {
    if (!this.guests.has(id)) return Promise.reject(new Error('The guest page is gone'));
    return this.request('webview-exec', { id, code: String(code) }, undefined);
  }

  openExternal(url) {
    if (!/^(https?|mailto):/i.test(url)) {
      console.warn(`[bruno-web] refusing to open non-web URL ${url}`);
      return;
    }
    this.notify('open-external', { url });
  }

  openAuthWindow(win, url) {
    this.authWindows.set(win.id, win);
    this.notify('auth-window-open', {
      window: win.id,
      url,
      callbackUrl: this.policy.oauthCallbackUrl()
    });
  }

  closeAuthWindow(win) {
    if (!this.authWindows.delete(win.id)) return;
    this.notify('auth-window-close', { window: win.id });
  }

  deliverAuthNavigation(windowId, url) {
    const win = windowId != null ? this.authWindows.get(windowId) : [...this.authWindows.values()].pop();
    if (!win) return false;
    win.deliverNavigation(String(url));
    return true;
  }
}

const sanitizeDialogOptions = (options = {}) => ({
  title: options.title,
  defaultPath: options.defaultPath,
  buttonLabel: options.buttonLabel,
  filters: options.filters,
  properties: options.properties || [],
  message: options.message,
  nameFieldLabel: options.nameFieldLabel
});

const waitForStableFile = async (filePath, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.promises.stat(filePath);
      // Wait for the size to settle so we do not hand out a half-written file.
      if (stat.size === lastSize) return stat;
      lastSize = stat.size;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

module.exports = { Hub, invokeContext };
