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

const LOGIN_CSP = 'default-src \'none\'; style-src \'unsafe-inline\'; form-action \'self\'; script-src \'unsafe-inline\'; img-src \'self\'; manifest-src \'self\'; frame-ancestors \'none\'; base-uri \'none\'';

// Home-screen / dock icons and the web app manifest (web/icons/, served without
// a login: browsers fetch the manifest without cookies).
const ICON_LINKS = [
  '<link rel="apple-touch-icon" href="/bruno-web/icons/apple-touch-icon.png">',
  '<link rel="manifest" href="/bruno-web/icons/manifest.webmanifest">'
].join('');

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
    ICON_LINKS,
    '<link rel="stylesheet" href="/bruno-web/static/bridge.css">',
    '<link rel="stylesheet" href="/bruno-web/static/mobile.css">',
    '<script src="/bruno-web/config.js"></script>',
    '<script src="/bruno-web/static/codec.js"></script>',
    '<script src="/bruno-web/static/i18n.js"></script>',
    '<script src="/bruno-web/static/ui.js"></script>',
    '<script src="/bruno-web/static/dialogs.js"></script>',
    '<script src="/bruno-web/static/webview.js"></script>',
    '<script src="/bruno-web/static/bridge.js"></script>',
    '<script src="/bruno-web/static/mobile.js" defer></script>'
  ].join('');
  if (!/<head>/i.test(upstreamHtml)) throw new Error('Unexpected renderer index.html: no <head>');
  // maximum-scale=1 stops iOS from zooming the page whenever an editor with a
  // small font gets focus; pinch zoom still works.
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">';
  return upstreamHtml
    .replace(/<meta name="viewport"[^>]*>/i, viewport)
    .replace(/<head>/i, (m) => `${m}${inject}`);
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

// Bruno's own palette (themes/light and themes/dark in the renderer), so the
// sign-in page looks like the app it opens.
const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f8f8f8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1a1a1a" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
${ICON_LINKS}
<style>
  :root { color-scheme: light dark; --bg: #f8f8f8; --card: #ffffff; --fg: #343434; --muted: #666666; --border: #e5e5e5; --input: #cccccc; --focus: #8b8b8b; --brand: hsl(33, 80%, 46%); --on-brand: #ffffff; --ring: hsla(33, 80%, 46%, 0.18); --error: hsl(8, 60%, 52%); --shadow: 0 1px 3px rgba(0, 0, 0, 0.06); }
  @media (prefers-color-scheme: dark) { :root { --bg: #1a1a1a; --card: #222224; --fg: #cccccc; --muted: #999999; --border: #333333; --input: #444444; --focus: #666666; --brand: hsl(39, 74%, 59%); --on-brand: #000000; --ring: hsla(39, 74%, 59%, 0.2); --error: hsl(8, 70%, 60%); --shadow: none; } }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg); font: 14px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: max(24px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
  .card { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 32px 28px 28px; }
  .logo { display: block; width: 56px; height: 56px; margin: 0 0 16px; }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 4px; font-weight: 600; }
  p { margin: 0 0 24px; color: var(--muted); }
  label { display: block; font-size: 13px; margin-bottom: 6px; }
  .field { position: relative; }
  input { width: 100%; height: 46px; padding: 0 48px 0 12px; border: 1px solid var(--input); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 16px; outline: none; -webkit-appearance: none; appearance: none; }
  input:focus { border-color: var(--focus); box-shadow: 0 0 0 3px var(--ring); }
  input[aria-invalid="true"] { border-color: var(--error); }
  .reveal { position: absolute; top: 1px; right: 1px; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border: 0; padding: 0; background: transparent; color: var(--muted); cursor: pointer; border-radius: 6px; }
  .reveal svg { width: 18px; height: 18px; }
  .reveal .off, .reveal[aria-pressed="true"] .on { display: none; }
  .reveal[aria-pressed="true"] .off { display: block; }
  .submit { margin-top: 20px; width: 100%; height: 46px; border: 0; border-radius: 6px; background: var(--brand); color: var(--on-brand); font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .submit:disabled { opacity: 0.7; cursor: default; }
  .error { display: flex; gap: 6px; align-items: flex-start; color: var(--error); margin: 10px 0 0; font-size: 13px; }
  .error svg { flex: none; width: 16px; height: 16px; margin-top: 2px; }
  /* On a phone: no card, and high enough on the screen that the keyboard leaves the field and the button in view. */
  @media (max-width: 480px) {
    body { align-items: flex-start; padding-top: max(14vh, env(safe-area-inset-top)); background: var(--card); }
    .card { border: 0; box-shadow: none; padding: 0 8px; }
  }
</style>
</head>
<body>${body}</body>
</html>`;

const ICON = {
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.7 5.1A10.7 10.7 0 0 1 21.9 11.7a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.4 2.4"/><path d="M14.1 14.2a3 3 0 0 1-4.2-4.2"/><path d="M17.5 17.5A10.7 10.7 0 0 1 2.1 12.4a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.4-5.3"/><path d="m2 2 20 20"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'
};
const svg = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const loginPage = (error) => page('Bruno', `
<form class="card" method="post" action="/bruno-web/login">
  <img class="logo" src="/bruno-web/icons/icon-192.png" alt="" width="56" height="56">
  <h1>Bruno</h1>
  <p id="hint">Sign in to continue.</p>
  <label for="password" id="label">Password</label>
  <div class="field">
    <input id="password" name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required${error ? ' aria-invalid="true" aria-describedby="error"' : ''}>
    <button type="button" class="reveal" id="reveal" aria-label="Show password" aria-pressed="false">${svg('eye', 'on')}${svg('eyeOff', 'off')}</button>
  </div>
  ${error ? `<div class="error" id="error" role="alert">${svg('alert')}<span id="error-text">${escapeHtml(error)}</span></div>` : ''}
  <button type="submit" class="submit" id="submit">Sign in</button>
</form>
<script>
  var zh = /^zh/i.test(navigator.language || '');
  var text = {
    show: zh ? '显示密码' : 'Show password',
    hide: zh ? '隐藏密码' : 'Hide password',
    busy: zh ? '正在登录…' : 'Signing in…'
  };
  if (zh) {
    document.documentElement.lang = 'zh-CN';
    document.getElementById('hint').textContent = '请登录后继续。';
    document.getElementById('label').textContent = '密码';
    document.getElementById('submit').textContent = '登录';
    var e = document.getElementById('error-text');
    if (e) e.textContent = ({ 'Wrong password': '密码错误', 'Too many attempts, try again in 15 minutes': '尝试次数过多，请 15 分钟后再试', 'Sign-in failed, please try again': '登录失败，请重试' })[e.textContent] || e.textContent;
  }
  var input = document.getElementById('password');
  var reveal = document.getElementById('reveal');
  reveal.setAttribute('aria-label', text.show);
  reveal.addEventListener('click', function () {
    var shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(shown));
    reveal.setAttribute('aria-label', shown ? text.hide : text.show);
    input.focus();
  });
  input.addEventListener('input', function () { input.removeAttribute('aria-invalid'); });
  document.querySelector('form').addEventListener('submit', function () {
    var b = document.getElementById('submit');
    // Disabled after this event, so the form still submits; a second tap does nothing.
    // A stopped navigation (Escape, the stop button) fires no event, so it re-enables itself.
    setTimeout(function () { b.disabled = true; b.textContent = text.busy; }, 0);
    setTimeout(function () { b.disabled = false; b.textContent = zh ? '登录' : 'Sign in'; }, 8000);
  });
  // Coming back with the browser's back button restores a disabled button.
  window.addEventListener('pageshow', function () { var b = document.getElementById('submit'); b.disabled = false; b.textContent = zh ? '登录' : 'Sign in'; });
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
