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
  let lastSeq = 0;
  let ackedSeq = 0;
  let ackTimer = null;

  const pendingInvokes = new Map(); // id -> { resolve, reject, channel }

  const isOpen = () => ws && ws.readyState === WebSocket.OPEN;

  const post = (msg) => {
    msg.id = ++nextId;
    const text = encode(msg);
    outbox.push({ id: msg.id, text });
    if (isOpen()) ws.send(text);
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

  const emit = (channel, args) => {
    const set = listeners.get(channel);
    if (!set || !set.size) {
      if (Date.now() - startedAt < EARLY_WINDOW_MS) {
        if (!early.has(channel)) early.set(channel, []);
        early.get(channel).push(args);
      }
      return;
    }
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[bruno-web] listener for ${channel} failed`, err);
      }
    }
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
      setTimeout(() => {
        for (const args of held) {
          if (set.has(wrapped)) {
            try { wrapped(...args); } catch (err) { console.error(`[bruno-web] listener for ${channel} failed`, err); }
          }
        }
      });
    }
    return () => set.delete(wrapped);
  };

  // --------------------------------------------------------------- server -> page calls
  const respond = (rpc, ok, valueOrError) => {
    post(ok ? { t: 'rpc-result', rpc, ok: true, value: valueOrError } : { t: 'rpc-result', rpc, ok: false, error: { message: String(valueOrError && valueOrError.message || valueOrError) } });
  };

  const onRpc = async ({ id, method, params }) => {
    try {
      let value;
      if (method === 'dialog-open') value = await dialogs.openDialog(params);
      else if (method === 'dialog-save') value = await dialogs.saveDialog(params);
      else if (method === 'message-box') value = await dialogs.messageBox(params);
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
  // uploaded and the server path it will have is returned at once; invoke()
  // waits for outstanding uploads, so the main process never sees a path
  // before the file exists. Files picked together share a folder, which keeps
  // sibling references (proto imports, WSDL schemas) working.
  const filePaths = new WeakMap();
  const uploads = new Set();
  let batchDir = null;

  const getFilePath = (file) => {
    if (!file || typeof file.name !== 'string') return '';
    if (filePaths.has(file)) return filePaths.get(file);
    if (!batchDir) {
      batchDir = uuid();
      setTimeout(() => { batchDir = null; });
    }
    const id = batchDir;
    const sep = settings.sep || '/';
    const safeName = file.name.replace(/[\\/]/g, '_') || 'file';
    const serverPath = `${settings.uploadsDir}${sep}${id}${sep}${safeName}`;
    filePaths.set(file, serverPath);
    const upload = fetch(`/bruno-web/api/upload/${id}/${encodeURIComponent(safeName)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(async (res) => {
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try { message = (await res.json()).error || message; } catch (e) {}
        throw new Error(t('uploadFailed', { error: message }));
      }
    });
    uploads.add(upload);
    upload.catch(() => {}).finally(() => uploads.delete(upload));
    upload.catch((err) => ui.toast(err.message, { level: 'error' }));
    return serverPath;
  };

  // --------------------------------------------------------------- ipcRenderer
  const invoke = async (channel, ...args) => {
    if (uploads.size) await Promise.all([...uploads]);
    return new Promise((resolve, reject) => {
      const id = nextId + 1;
      pendingInvokes.set(id, { resolve, reject, channel });
      post({ t: 'invoke', ch: channel, args });
    });
  };

  window.ipcRenderer = {
    invoke,
    send: (channel, ...args) => {
      post({ t: 'send', ch: channel, args });
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
      if (channel === undefined) listeners.clear();
      else listeners.delete(channel);
    },
    getFilePath,
    openExternal: (url) => dialogs.openExternal(url)
  };

  ui.connectionState('connecting');
  connect();
})();
