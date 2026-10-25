/*
 * Browser stand-in for Electron's <webview>, used upstream for HTML response
 * previews and Bruno apps.
 *
 * `webview` has no hyphen, so it cannot be a custom element. Instead every
 * element created with document.createElement('webview') (what React does) is
 * fitted with the parts of the <webview> API the renderer uses:
 *   - executeJavaScript(code) -> Promise
 *   - events: dom-ready, did-start-loading, console-message ({ message, level })
 * and renders a sandboxed iframe (opaque origin) as its only child. The guest
 * document gets a bootstrap script from the server that forwards console
 * output and runs executeJavaScript requests (see server/pages.js).
 *
 * Sources:
 *   bruno-app://<token>/  -> /bruno-web/app-doc/<token>
 *   data:text/html,...    -> uploaded to /bruno-web/api/preview, served with its own CSP
 */
(function () {
  const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';
  // Same as upstream's guest session (app-documents.js): writing to the
  // clipboard is the only permission a guest gets.
  const ALLOW = [
    'clipboard-write',
    "clipboard-read 'none'",
    "camera 'none'",
    "microphone 'none'",
    "geolocation 'none'",
    "display-capture 'none'",
    "usb 'none'",
    "serial 'none'",
    "hid 'none'",
    "bluetooth 'none'",
    "payment 'none'",
    "midi 'none'"
  ].join('; ');

  const toFrameUrl = async (src) => {
    if (!src) return 'about:blank';
    const appDoc = /^bruno-app:\/\/([^/]+)/i.exec(src);
    if (appDoc) return `/bruno-web/app-doc/${encodeURIComponent(appDoc[1])}`;
    if (/^data:text\/html/i.test(src)) {
      const comma = src.indexOf(',');
      const meta = src.slice(0, comma);
      const payload = src.slice(comma + 1);
      const html = /;base64/i.test(meta) ? atob(payload) : decodeURIComponent(payload);
      const res = await fetch('/bruno-web/api/preview', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: html
      });
      if (!res.ok) throw new Error(`preview upload failed: ${res.status}`);
      return (await res.json()).url;
    }
    if (/^https?:/i.test(src)) return src;
    return 'about:blank';
  };

  let execSeq = 0;
  const EXEC_TIMEOUT_MS = 30000;
  const guests = new WeakMap(); // guest WindowProxy -> webview state

  const live = new Set(); // states whose iframe may not be mapped yet

  const findGuest = (source) => {
    if (!source) return null;
    let state = guests.get(source);
    if (state) return state;
    for (const s of live) {
      if (s.frame.contentWindow === source) {
        s.shown = true;
        guests.set(source, s);
        return s;
      }
      // Removed from the page after having been shown: forget it.
      if (s.shown && !s.frame.isConnected) live.delete(s);
    }
    return null;
  };

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.__brunoWeb !== 'string') return;
    const state = findGuest(event.source);
    if (state) state.onMessage(data);
  });

  // Guests are reported to the server so the main process can address them
  // like Electron guest webContents (webContents.getAllWebContents()).
  let guestSeq = 0;
  const byId = new Map(); // id -> element
  let reporter = () => {};
  const report = (op, info) => {
    try { reporter(op, info); } catch (e) {}
  };

  const forget = (node) => {
    if (node.nodeType !== 1) return;
    const found = node.matches && node.matches('webview') ? [node] : [...node.querySelectorAll('webview')];
    for (const el of found) {
      const state = el.__brunoWebview;
      if (!state || el.isConnected || !byId.has(state.id)) continue;
      byId.delete(state.id);
      for (const [, p] of state.pending) p.reject(new Error('webview was removed'));
      state.pending.clear();
      report('remove', { id: state.id });
    }
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.removedNodes) forget(n);
  }).observe(document.documentElement, { childList: true, subtree: true });

  const upgrade = (el) => {
    if (el.__brunoWebview) return;
    const state = { id: ++guestSeq, frame: null, loadToken: 0, pending: new Map() };
    el.__brunoWebview = state;

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('allow', ALLOW);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = 'border:0;width:100%;height:100%;flex:1 1 auto;display:block;background:transparent;';
    state.frame = frame;

    const dispatch = (type, props) => {
      const ev = new Event(type);
      Object.assign(ev, props || {});
      el.dispatchEvent(ev);
    };

    const load = async () => {
      const token = ++state.loadToken;
      dispatch('did-start-loading');
      for (const [, p] of state.pending) p.reject(new Error('webview navigated'));
      state.pending.clear();
      let url;
      try {
        url = await toFrameUrl(el.getAttribute('src'));
      } catch (err) {
        console.error('[bruno-web] webview source failed', err);
        url = 'about:blank';
      }
      if (token !== state.loadToken) return;
      frame.src = url;
      byId.set(state.id, el);
      report('set', { id: state.id, url: el.getAttribute('src') || '' });
    };

    state.onMessage = (data) => {
      if (data.__brunoWeb === 'dom-ready') dispatch('dom-ready');
      else if (data.__brunoWeb === 'console') dispatch('console-message', { message: String(data.message), level: data.level });
      else if (data.__brunoWeb === 'exec-result') {
        const p = state.pending.get(data.id);
        if (!p) return;
        state.pending.delete(data.id);
        if (data.ok) p.resolve(data.value);
        else p.reject(new Error(data.error));
      }
    };
    live.add(state);

    el.executeJavaScript = (code) => new Promise((resolve, reject) => {
      const win = frame.contentWindow;
      if (!win) return reject(new Error('webview is not attached'));
      guests.set(win, state);
      const id = ++execSeq;
      // A guest without our bootstrap (load failure, navigated away) never answers.
      const timer = setTimeout(() => {
        if (!state.pending.delete(id)) return;
        reject(new Error('webview did not answer executeJavaScript'));
      }, EXEC_TIMEOUT_MS);
      state.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      win.postMessage({ __brunoWeb: 'exec', id, code: String(code) }, '*');
    });
    el.getURL = () => el.getAttribute('src') || '';
    el.reload = () => load();
    el.openDevTools = () => {};
    el.closeDevTools = () => {};
    el.isDevToolsOpened = () => false;
    el.getWebContentsId = () => state.id;

    new MutationObserver(() => load()).observe(el, { attributes: true, attributeFilter: ['src'] });

    // React owns no children of <webview>, so the iframe can live inside it.
    el.appendChild(frame);
    if (el.hasAttribute('src')) load();
  };

  const originalCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, options) {
    const el = originalCreateElement.call(this, tagName, options);
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') upgrade(el);
    return el;
  };

  window.BrunoWebWebview = {
    upgrade,
    setReporter(fn) {
      reporter = fn;
      for (const [id, el] of byId) report('set', { id, url: el.getAttribute('src') || '' });
    },
    exec(id, code) {
      const el = byId.get(id);
      if (!el) return Promise.reject(new Error(`no webview ${id}`));
      return el.executeJavaScript(code);
    }
  };
})();
