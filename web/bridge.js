/*
 * window.ipcRenderer for the browser: the same five methods Bruno's preload
 * exposes (invoke / send / on / getFilePath / openExternal), carried over one
 * WebSocket to the Bruno Web server. Must run before the renderer bundle.
 *
 * Delivery protocol (see server/session.js): server messages carry `seq` and
 * are acknowledged; page messages carry an increasing `id` and stay in the
 * outbox until the server reports (`rx`) that it has received them, so a
 * reconnect resends exactly what was lost. When the server cannot resume this
 * page, the page reloads — its in-memory state would no longer match.
 */
(function () {
  const settings = window.__BRUNO_WEB__ || {};
  const { encode, decode } = window.BrunoWebCodec;
  const ui = window.BrunoWebUI;
  const dialogs = window.BrunoWebDialogs;
  const { t } = window.BrunoWebI18n;

  // --------------------------------------------------------------- platform
  // Bruno's renderer picks path.win32/path.posix (and case-insensitive path
  // keys) from the *browser's* OS via the `platform` package, but the files
  // live on the server. Keyboard shortcuts are the only other thing that reads
  // it, and Windows and Linux share them, so a Windows browser is reported as
  // Linux when the server is not Windows.
  if (settings.platform && settings.platform !== 'win32' && /Windows/i.test(navigator.userAgent)) {
    const ua = navigator.userAgent.replace(/\(Windows[^)]*\)/i, '(X11; Linux x86_64)');
    try {
      Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
      Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64', configurable: true });
    } catch (e) {
      console.warn('[bruno-web] could not adjust the reported platform', e);
    }
  }

  window.isPlaywright = settings.playwright === true;

  // --------------------------------------------------------------- utilities
  const uuid = () => {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  const pageId = uuid();

  // --------------------------------------------------------------- connection
  let ws = null;
  let everConnected = false;
  let stopped = false;
  let reconnectDelay = 500;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let pongTimer = null;

  let nextId = 0;
  const outbox = []; // { id, text } sent or queued, not yet confirmed received
  // Numbered messages go out only after the server's hello on the current
  // socket: it tells us which ids it already has, and the server drops any id
  // at or below the highest it has seen, so a new message must never overtake
  // an older one that still has to be resent.
  let ready = false;
  let lastSeq = 0;
  let ackedSeq = 0;
  let ackTimer = null;

  const pendingInvokes = new Map(); // id -> { resolve, reject, channel }

  const isOpen = () => ws && ws.readyState === WebSocket.OPEN;

  const debug = settings.debugIpc
    ? (dir, msg) => console.debug(`[bruno-web ipc] ${dir} ${msg.t} ${msg.ch || msg.method || ''} #${msg.id != null ? msg.id : ''}${msg.seq != null ? ` seq ${msg.seq}` : ''}`)
    : () => {};

  const maxBytes = settings.maxMessageBytes || 64 * 1024 * 1024;
  const byteLength = (text) => (text.length * 3 <= maxBytes ? text.length : new TextEncoder().encode(text).length);

  // Throws, without queueing, if the message could never be delivered: the
  // server closes the socket on oversized messages, and resending would loop.
  const post = (msg) => {
    const text = encode({ ...msg, id: nextId + 1 });
    if (byteLength(text) > maxBytes) {
      throw new Error(`Message too large for Bruno Web (${Math.round(byteLength(text) / 1048576)} MB, limit ${Math.round(maxBytes / 1048576)} MB)`);
    }
    msg.id = ++nextId;
    debug('->', msg);
    outbox.push({ id: msg.id, text });
    if (ready && isOpen()) ws.send(text);
    return msg.id;
  };

  const confirmReceived = (rx) => {
    while (outbox.length && outbox[0].id <= rx) outbox.shift();
  };

  const scheduleAck = () => {
    if (ackTimer) return;
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (lastSeq > ackedSeq && isOpen()) {
        ackedSeq = lastSeq;
        ws.send(encode({ t: 'ack', seq: lastSeq }));
      }
    }, 300);
  };

  const stop = (state, opts) => {
    stopped = true;
    ready = false;
    // Nothing queued here will be answered any more.
    outbox.length = 0;
    for (const [id, pending] of pendingInvokes) {
      pendingInvokes.delete(id);
      pending.reject(new Error(`Error invoking remote method '${pending.channel}': Error: Bruno Web connection closed (${state})`));
    }
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(pongTimer);
    if (ws) {
      try { ws.close(); } catch (e) {}
    }
    ui.connectionState(state, opts);
  };

  const reloadPage = () => {
    stop('reloading');
    setTimeout(() => location.reload(), 300);
  };

  const checkLogin = async () => {
    try {
      const res = await fetch('/bruno-web/config.js', { credentials: 'same-origin', cache: 'no-store' });
      return res.status !== 401;
    } catch (e) {
      return true; // Server unreachable: keep retrying, it is not a login problem.
    }
  };

  const onAuthExpired = () => stop('auth-expired', { onAction: () => { location.href = '/bruno-web/login'; } });

  const connect = () => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}/bruno-web/ws?page=${pageId}&last=${lastSeq}`);
    ws = socket;

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = decode(event.data);
      } catch (e) {
        console.error('[bruno-web] bad message from server', e);
        return;
      }
      handleMessage(msg);
    };

    socket.onclose = async (event) => {
      if (ws !== socket) return;
      ready = false;
      clearInterval(heartbeatTimer);
      clearTimeout(pongTimer);
      if (stopped) return;
      if (event.code === 4001) return; // taken over; handled by the message
      if (event.code === 4401 || !(await checkLogin())) return onAuthExpired();
      if (everConnected) ui.connectionState('reconnecting');
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    };
  };

  const startHeartbeat = () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!isOpen()) return;
      ws.send(encode({ t: 'ping' }));
      clearTimeout(pongTimer);
      // No answer: the socket is dead even if the browser has not noticed yet.
      pongTimer = setTimeout(() => { try { ws.close(); } catch (e) {} }, 10000);
    }, 15000);
  };

  // --------------------------------------------------------------- inbound
  const handleMessage = (msg) => {
    debug('<-', msg);
    if (msg.seq != null) {
      if (msg.seq <= lastSeq) return; // replayed twice
      lastSeq = msg.seq;
      scheduleAck();
    }
    switch (msg.t) {
      case 'hello':
        return onHello(msg);
      case 'pong':
        clearTimeout(pongTimer);
        confirmReceived(msg.rx);
        return;
      case 'taken-over':
        return stop('taken-over', { onAction: () => location.reload() });
      case 'auth-expired':
        return onAuthExpired();
      case 'reload-required':
        return reloadPage();
      case 'result':
        return onResult(msg);
      case 'event':
        return emit(msg.ch, msg.args || []);
      case 'notify':
        return onNotify(msg.method, msg.params || {});
      case 'rpc':
        return onRpc(msg);
      default:
        console.warn('[bruno-web] unknown server message', msg.t);
    }
  };

  const onHello = (msg) => {
    if (!msg.resumed && everConnected) {
      // The server no longer has this page's state (restart, long outage, or
      // too much missed); the renderer state would be stale.
      return reloadPage();
    }
    const first = !everConnected;
    everConnected = true;
    reconnectDelay = 500;
    ui.connectionState(null);
    confirmReceived(msg.rx || 0);
    for (const entry of outbox) ws.send(entry.text);
    ready = true;
    startHeartbeat();
    if (first) {
      reportTheme();
      if (document.readyState === 'complete') pageLoaded();
      else window.addEventListener('load', pageLoaded, { once: true });
    }
  };

  const onResult = ({ id, ok, value, error }) => {
    const pending = pendingInvokes.get(id);
    if (!pending) return;
    pendingInvokes.delete(id);
    if (ok) pending.resolve(value);
    // A real Error: the renderer's formatIpcError() only unwraps Error instances.
    else pending.reject(new Error(error && error.message ? error.message : `Error invoking remote method '${pending.channel}'`));
  };

  // --------------------------------------------------------------- events
  const listeners = new Map(); // channel -> Set<fn>

  // Events that arrive before the renderer has subscribed (it subscribes in
  // React effects, after this script) are held briefly and handed to the
  // first listener, so start-up events such as main:app-loaded are not lost.
  const EARLY_WINDOW_MS = 10000;
  const startedAt = Date.now();
  const early = new Map(); // channel -> args[]
  const replaying = new Map(); // channel -> args[] queued behind held events

  const dispatch = (channel, args) => {
    const set = listeners.get(channel);
    if (!set) return;
    for (const fn of [...set]) {
      if (!set.has(fn)) continue;
      try {
        fn(...args);
      } catch (err) {
        console.error(`[bruno-web] listener for ${channel} failed`, err);
      }
    }
  };

  const emit = (channel, args) => {
    // Held events are still being handed over: keep arrival order.
    if (replaying.has(channel)) {
      replaying.get(channel).push(args);
      return;
    }
    const set = listeners.get(channel);
    if (!set || !set.size) {
      if (Date.now() - startedAt < EARLY_WINDOW_MS) {
        if (!early.has(channel)) early.set(channel, []);
        early.get(channel).push(args);
      }
      return;
    }
    dispatch(channel, args);
  };

  const on = (channel, handler) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    const set = listeners.get(channel);
    // Wrap so the same function can subscribe twice, as with ipcRenderer.on.
    const wrapped = (...args) => handler(...args);
    set.add(wrapped);
    const held = early.get(channel);
    if (held) {
      early.delete(channel);
      replaying.set(channel, held);
      // Asynchronously, as Electron delivers events, after the subscriber's
      // own synchronous setup has finished.
      setTimeout(() => {
        const queue = replaying.get(channel) || [];
        replaying.delete(channel);
        for (const args of queue) dispatch(channel, args);
      });
    }
    return () => set.delete(wrapped);
  };

  // --------------------------------------------------------------- server -> page calls
  const respond = (rpc, ok, valueOrError) => {
    const failure = (err) => ({ t: 'rpc-result', rpc, ok: false, error: { message: String((err && err.message) || err) } });
    try {
      post(ok ? { t: 'rpc-result', rpc, ok: true, value: valueOrError } : failure(valueOrError));
    } catch (err) {
      post(failure(err));
    }
  };

  const onRpc = async ({ id, method, params }) => {
    try {
      let value;
      if (method === 'dialog-open') value = await dialogs.openDialog(params);
      else if (method === 'dialog-save') value = await dialogs.saveDialog(params);
      else if (method === 'message-box') value = await dialogs.messageBox(params);
      else if (method === 'webview-exec') value = await window.BrunoWebWebview.exec(params.id, params.code);
      else throw new Error(`unknown request ${method}`);
      respond(id, true, value);
    } catch (err) {
      respond(id, false, err);
    }
  };

  const onNotify = (method, params) => {
    switch (method) {
      case 'toast':
        ui.toast(params.message, { level: params.level, title: params.title, timeout: params.level === 'error' ? 12000 : 8000 });
        return;
      case 'open-external':
        dialogs.openExternal(params.url);
        return;
      case 'download':
        dialogs.download(params);
        return;
      case 'zoom':
        // Electron zoom levels are steps of 20 % on a log scale.
        document.documentElement.style.zoom = String(Math.pow(1.2, Number(params.level) || 0));
        return;
      case 'reload':
        location.reload();
        return;
      case 'window-size':
        window.dispatchEvent(new CustomEvent('bruno-web:window-size', { detail: params }));
        return;
      case 'clipboard':
        if (navigator.clipboard) navigator.clipboard.writeText(params.text).catch(() => {});
        return;
      case 'auth-window-open':
        dialogs.openAuthWindow(params, {
          navigate: (url) => post({ t: 'auth-nav', window: params.window, url }),
          close: () => post({ t: 'auth-close', window: params.window })
        });
        return;
      case 'auth-window-close':
        dialogs.closeAuthWindow(params.window);
        return;
      default:
        console.warn('[bruno-web] unknown notification', method);
    }
  };

  // --------------------------------------------------------------- page state reports
  let loadedReported = false;
  const pageLoaded = () => {
    if (loadedReported) return;
    loadedReported = true;
    post({ t: 'page-loaded' });
  };

  let lastDark = null;
  const reportTheme = () => {
    const dark = document.documentElement.classList.contains('dark');
    if (dark === lastDark) return;
    lastDark = dark;
    post({ t: 'theme', dark });
  };
  new MutationObserver(reportTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // --------------------------------------------------------------- getFilePath
  // Electron returns the file's local path synchronously. Here the file is
  // uploaded and the server path it will have is returned at once; an invoke
  // whose arguments mention that path waits for the upload (and fails if the
  // upload failed), so the main process never sees a path before the file
  // exists. Files picked in the same turn share a folder, which keeps sibling
  // references working; a second file with the same name gets its own folder.
  const filePaths = new WeakMap(); // File -> server path
  const uploads = new Map(); // server path -> { promise, error }
  let batch = null; // { dir, names }

  const getFilePath = (file) => {
    if (!file || typeof file.name !== 'string') return '';
    const known = filePaths.get(file);
    // Picking the same file again after a failed upload retries it.
    if (known && !(uploads.get(known) && uploads.get(known).error)) return known;

    const name = file.name.replace(/[\\/]/g, '_') || 'file';
    if (!batch || batch.names.has(name)) {
      batch = { dir: uuid(), names: new Set() };
      const current = batch;
      setTimeout(() => { if (batch === current) batch = null; });
    }
    batch.names.add(name);
    const sep = settings.sep || '/';
    const serverPath = `${settings.uploadsDir}${sep}${batch.dir}${sep}${name}`;
    filePaths.set(file, serverPath);
    const entry = { error: null };
    const dir = batch.dir;
    entry.promise = fetch(`/bruno-web/api/upload/${dir}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(async (res) => {
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try { message = (await res.json()).error || message; } catch (e) {}
        throw new Error(message);
      }
    }).catch((err) => {
      entry.error = new Error(t('uploadFailed', { error: err.message }));
      ui.toast(entry.error.message, { level: 'error' });
    });
    uploads.set(serverPath, entry);
    return serverPath;
  };

  // Uploads whose server path appears in the arguments.
  const uploadsReferencedBy = (args) => {
    if (!uploads.size) return [];
    let text;
    try {
      text = JSON.stringify(args);
    } catch (e) {
      return [...uploads.values()];
    }
    const out = [];
    for (const [p, entry] of uploads) {
      if (text.includes(JSON.stringify(p).slice(1, -1))) out.push(entry);
    }
    return out;
  };

  // --------------------------------------------------------------- ipcRenderer
  const invokeError = (channel, err) => new Error(`Error invoking remote method '${channel}': Error: ${err.message}`);

  const invoke = async (channel, ...args) => {
    const needed = uploadsReferencedBy(args);
    if (needed.length) {
      await Promise.all(needed.map((e) => e.promise));
      const failed = needed.find((e) => e.error);
      if (failed) throw invokeError(channel, failed.error);
    }
    if (stopped) throw invokeError(channel, new Error('Bruno Web connection closed'));
    return new Promise((resolve, reject) => {
      const id = nextId + 1;
      pendingInvokes.set(id, { resolve, reject, channel });
      try {
        post({ t: 'invoke', ch: channel, args });
      } catch (err) {
        pendingInvokes.delete(id);
        reject(invokeError(channel, err));
      }
    });
  };

  window.ipcRenderer = {
    invoke,
    send: (channel, ...args) => {
      if (stopped) return;
      try {
        post({ t: 'send', ch: channel, args });
      } catch (err) {
        ui.toast(err.message, { level: 'error' });
      }
    },
    on,
    once: (channel, handler) => {
      const off = on(channel, (...args) => {
        off();
        handler(...args);
      });
      return off;
    },
    removeAllListeners: (channel) => {
      // Clear the sets too: a pending replay holds on to them.
      for (const [ch, set] of listeners) {
        if (channel === undefined || ch === channel) set.clear();
      }
      if (channel === undefined) listeners.clear();
      else listeners.delete(channel);
    },
    getFilePath,
    // Electron's preload returns shell.openExternal()'s promise.
    openExternal: (url) => Promise.resolve(dialogs.openExternal(url))
  };

  // The desktop app asks before quitting with unsaved changes; a closing or
  // reloading tab gets the browser's own confirmation instead. Unsaved request
  // tabs carry Bruno's draft marker.
  window.addEventListener('beforeunload', (event) => {
    if (stopped) return;
    if (!document.querySelector('.has-changes-icon')) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // Keeps the login cookie fresh while the page is in use; a 401 means the
  // session is gone.
  setInterval(() => {
    if (stopped) return;
    fetch('/bruno-web/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => { if (res.status === 401) onAuthExpired(); })
      .catch(() => {});
  }, 15 * 60 * 1000);

  window.BrunoWebWebview.setReporter((op, { id, url }) => post({ t: 'webview', op, guest: id, url }));

  ui.connectionState('connecting');
  connect();
})();
