/**
 * HTML served by Bruno Web itself: the patched renderer index, the login page,
 * the OAuth2 "done" page and the guest bootstrap for sandboxed iframes.
 */

// Upstream's Electron CSP (bruno-electron/src/index.js) with the differences a
// browser deployment needs: no PostHog, and frames from our own preview/app
// document routes.
const APP_CSP = [
  'default-src \'self\'',
  'connect-src \'self\'',
  'font-src \'self\' https: data:',
  'frame-src \'self\' data:',
  'script-src \'self\' data:',
  'img-src \'self\' blob: data: http: https:',
  'media-src \'self\' blob: data: https:',
  'style-src \'self\' \'unsafe-inline\' https:',
  'worker-src \'self\' blob:',
  'object-src \'none\'',
  'base-uri \'self\'',
  'frame-ancestors \'none\''
].join('; ');

const LOGIN_CSP = 'default-src \'none\'; style-src \'unsafe-inline\'; form-action \'self\'; script-src \'unsafe-inline\'; frame-ancestors \'none\'; base-uri \'none\'';

// Guest documents (HTML previews, Bruno apps) run in a sandboxed iframe with an
// opaque origin; they cannot reach our cookies or the page.
const GUEST_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Load the bridge before the renderer bundle: upstream's bundle is `defer`,
 * our scripts are not, so window.ipcRenderer exists before any app code runs.
 */
const buildIndexHtml = (upstreamHtml) => {
  const inject = [
    '<link rel="stylesheet" href="/bruno-web/static/bridge.css">',
    '<script src="/bruno-web/config.js"></script>',
    '<script src="/bruno-web/static/codec.js"></script>',
    '<script src="/bruno-web/static/i18n.js"></script>',
    '<script src="/bruno-web/static/ui.js"></script>',
    '<script src="/bruno-web/static/dialogs.js"></script>',
    '<script src="/bruno-web/static/webview.js"></script>',
    '<script src="/bruno-web/static/bridge.js"></script>'
  ].join('');
  if (!/<head>/i.test(upstreamHtml)) throw new Error('Unexpected renderer index.html: no <head>');
  return upstreamHtml.replace(/<head>/i, (m) => `${m}${inject}`);
};

/**
 * Runs first inside every guest document. Replaces what Electron's <webview>
 * provided: console-message events (the Bruno app protocol posts JSON through
 * console.log) and executeJavaScript().
 */
const GUEST_BOOTSTRAP = `<script>(function () {
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  var post = function (msg) { try { parentWin.postMessage(msg, '*'); } catch (e) {} };
  var levels = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };
  Object.keys(levels).forEach(function (name) {
    var original = console[name] ? console[name].bind(console) : function () {};
    console[name] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        if (typeof a === 'string') parts.push(a);
        else { try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); } }
      }
      post({ __brunoWeb: 'console', level: levels[name], message: parts.join(' ') });
      return original.apply(null, arguments);
    };
  });
  window.addEventListener('message', function (event) {
    if (event.source !== parentWin) return;
    var data = event.data;
    if (!data || data.__brunoWeb !== 'exec') return;
    Promise.resolve().then(function () {
      return (0, eval)(data.code);
    }).then(function (value) {
      // Structured clone, as Electron's executeJavaScript returns values.
      try {
        parentWin.postMessage({ __brunoWeb: 'exec-result', id: data.id, ok: true, value: value }, '*');
      } catch (e) {
        post({ __brunoWeb: 'exec-result', id: data.id, ok: false, error: 'Result could not be cloned: ' + (e && e.message) });
      }
    }, function (err) {
      post({ __brunoWeb: 'exec-result', id: data.id, ok: false, error: String(err && err.message || err) });
    });
  });
  var ready = function () { post({ __brunoWeb: 'dom-ready' }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();</script>`;

const injectGuestBootstrap = (html) => {
  const doc = String(html || '');
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}${GUEST_BOOTSTRAP}`);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (m) => `${m}<head>${GUEST_BOOTSTRAP}</head>`);
  return `${GUEST_BOOTSTRAP}${doc}`;
};

const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f8; --card: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d0d7de; --accent: #e5a50a; --accent-fg: #1f2328; --error: #cf222e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1e1e1e; --card: #252526; --fg: #e6e6e6; --muted: #9da5b4; --border: #3c3c3c; --error: #ff7b72; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg); font: 14px/1.5 Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: 16px; }
  .card { width: 100%; max-width: 340px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 28px 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  p { margin: 0 0 20px; color: var(--muted); }
  label { display: block; font-size: 13px; margin-bottom: 6px; }
  input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button { margin-top: 16px; width: 100%; padding: 8px 10px; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: var(--error); margin: 12px 0 0; font-size: 13px; }
</style>
</head>
<body>${body}</body>
</html>`;

const loginPage = (error) => page('Bruno', `
<form class="card" method="post" action="/bruno-web/login">
  <h1>Bruno</h1>
  <p id="hint">Sign in to continue.</p>
  <label for="password" id="label">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit" id="submit">Sign in</button>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
</form>
<script>
  if (/^zh/i.test(navigator.language || '')) {
    document.documentElement.lang = 'zh-CN';
    document.getElementById('hint').textContent = '请登录后继续。';
    document.getElementById('label').textContent = '密码';
    document.getElementById('submit').textContent = '登录';
    var e = document.querySelector('.error');
    if (e) e.textContent = ({ 'Wrong password': '密码错误', 'Too many attempts, try again in 15 minutes': '尝试次数过多，请 15 分钟后再试', 'Sign-in failed, please try again': '登录失败，请重试' })[e.textContent] || e.textContent;
  }
</script>`);

const CALLBACK_CSP = 'default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'self\'; frame-ancestors \'none\'; base-uri \'none\'';

// Hands the full address (including the #fragment used by the implicit flow)
// to the server; see the route in server/index.js.
const oauthCallbackPage = () => page('Bruno', `
<div class="card">
  <h1 id="t">Completing sign-in…</h1>
  <p id="d"></p>
</div>
<script>
  var zh = /^zh/i.test(navigator.language || '');
  var text = {
    working: zh ? '正在完成登录…' : 'Completing sign-in…',
    done: zh ? '已收到授权' : 'Authorization received',
    doneDetail: zh ? '可以关闭此窗口，回到 Bruno。' : 'You can close this window and return to Bruno.',
    none: zh ? '没有进行中的授权' : 'No authorization in progress',
    noneDetail: zh ? '请先在 Bruno 中发起 OAuth 2.0 授权，再重试。' : 'Start the OAuth 2.0 flow from Bruno, then try again.',
    login: zh ? '无法提交授权结果' : 'Could not hand the result to Bruno',
    loginDetail: zh ? '请确认已在这个浏览器里登录 Bruno，然后在 Bruno 的登录面板中粘贴本页地址：' : "Make sure you are signed in to Bruno in this browser, then paste this page's address into Bruno's sign-in panel:"
  };
  var title = document.getElementById('t');
  var detail = document.getElementById('d');
  title.textContent = text.working;
  fetch('/bruno-web/api/oauth2/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ url: location.href })
  }).then(function (res) {
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }).then(function (body) {
    title.textContent = body.handled ? text.done : text.none;
    detail.textContent = body.handled ? text.doneDetail : text.noneDetail;
    if (body.handled) setTimeout(function () { window.close(); }, 800);
  }).catch(function () {
    title.textContent = text.login;
    detail.textContent = text.loginDetail + ' ' + location.href;
  });
</script>`);

module.exports = {
  APP_CSP,
  LOGIN_CSP,
  GUEST_CSP,
  buildIndexHtml,
  injectGuestBootstrap,
  CALLBACK_CSP,
  loginPage,
  oauthCallbackPage
};
