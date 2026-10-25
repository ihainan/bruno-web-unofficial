/*
 * Small UI kit for the Bruno Web additions (file dialogs, prompts, toasts,
 * connection state). Rendered in a shadow root so neither side's CSS leaks;
 * colours follow Bruno's default light/dark palettes and switch with the
 * `dark` class Bruno puts on <html>.
 */
(function () {
  const { t } = window.BrunoWebI18n;

  const STYLE = `
:host { all: initial; }
.layer {
  --bg: #ffffff; --mantle: #f8f8f8; --surface: #f1f1f1; --surface-2: #eaeaea;
  --text: #343434; --sub: #838383; --sub-2: #666666;
  --border: #e5e5e5; --border-strong: #cccccc;
  --primary: hsl(33, 80%, 46%); --primary-text: hsl(33, 67%, 45%); --primary-soft: hsla(33, 80%, 46%, 0.12);
  --danger: hsl(8, 60%, 52%); --warning: hsl(35, 85%, 42%); --info: hsl(214, 55%, 45%);
  --backdrop: rgba(0, 0, 0, 0.32);
  --shadow: 0 2px 12px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05);
  font: 13px/1.45 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
.layer.dark {
  --bg: hsl(0, 0%, 10%); --mantle: #222224; --surface: #26292b; --surface-2: hsl(204, 4%, 23%);
  --text: hsl(0, 0%, 80%); --sub: #999999; --sub-2: #aaaaaa;
  --border: #333333; --border-strong: #444444;
  --primary: hsl(39, 74%, 59%); --primary-text: hsl(39, 74%, 64%); --primary-soft: hsla(39, 74%, 59%, 0.14);
  --danger: hsl(8, 70%, 58%); --warning: hsl(39, 74%, 59%); --info: hsl(214, 60%, 62%);
  --backdrop: rgba(0, 0, 0, 0.55);
  --shadow: 0 2px 12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
}
* { box-sizing: border-box; }
button, input { font: inherit; color: inherit; }
svg { display: block; flex: none; }

.backdrop { position: fixed; inset: 0; background: var(--backdrop); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 2147483000; }
.modal { background: var(--bg); border-radius: 8px; box-shadow: var(--shadow); width: 100%; max-width: 560px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden; }
.modal.wide { max-width: 680px; }
.modal-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; }
.modal-title { font-size: 14px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal-body { padding: 0 16px 12px; overflow: auto; min-height: 0; }
.modal-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--mantle); }
.spacer { flex: 1; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--bg); cursor: pointer; white-space: nowrap; }
.btn:hover { background: var(--surface); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 500; }
.layer.dark .btn.primary { color: #1a1a1a; }
.btn.primary:hover { filter: brightness(1.06); }
.btn.ghost { border-color: transparent; background: transparent; color: var(--sub-2); padding: 0 8px; }
.btn.ghost:hover { background: var(--surface); color: var(--text); }
.btn.icon { width: 28px; padding: 0; }
.btn:focus-visible, .crumb:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
/* Rows sit flush against the list's clipped edge: draw their ring inside. */
.row:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }

.input { width: 100%; height: 30px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); }
.input:focus { border-color: var(--primary); outline: none; }
.label { display: block; color: var(--sub-2); margin: 10px 0 6px; }
.muted { color: var(--sub); }
.text { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
.detail { margin: 0; color: var(--sub-2); white-space: pre-wrap; word-break: break-word; }

.bar { display: flex; align-items: center; gap: 4px; padding: 6px 0 8px; min-width: 0; }
.crumbs { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; overflow: hidden; }
.crumb { border: 0; background: transparent; padding: 2px 6px; border-radius: 4px; cursor: pointer; color: var(--sub-2); white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.crumb:hover { background: var(--surface); color: var(--text); }
.crumb.current { color: var(--text); font-weight: 500; }
.crumb-sep { color: var(--sub); flex: none; }
.list { border: 1px solid var(--border); border-radius: 6px; height: 320px; overflow: auto; background: var(--bg); }
.row { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; cursor: default; user-select: none; outline: none; }
.row:hover { background: var(--surface); }
.row.selected { background: var(--primary-soft); }
.row.disabled { color: var(--sub); }
.row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { color: var(--sub); font-variant-numeric: tabular-nums; flex: none; }
.row svg { color: var(--sub-2); }
.row.dir svg { color: var(--primary-text); }
.empty { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--sub); padding: 16px; text-align: center; }
.status { min-height: 18px; margin-top: 8px; color: var(--sub-2); }
.status.error { color: var(--danger); }
.seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 6px; overflow: hidden; }
.seg button { border: 0; background: var(--bg); height: 28px; padding: 0 12px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--border-strong); }
.seg button.on { background: var(--primary-soft); color: var(--primary-text); font-weight: 500; }
.field-row { display: flex; gap: 8px; align-items: center; }
.check { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: var(--sub-2); }

.toasts { position: fixed; left: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 2147483100; max-width: min(420px, calc(100vw - 32px)); }
.toast { background: var(--bg); box-shadow: var(--shadow); border-radius: 6px; padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; }
.toast .msg { flex: 1; min-width: 0; word-break: break-word; }
.toast .ttl { font-weight: 600; display: block; }
.toast.error .ttl, .toast.error .lvl { color: var(--danger); }
.toast.warning .ttl, .toast.warning .lvl { color: var(--warning); }
.toast .actions { display: flex; gap: 4px; flex: none; }

.cover { position: fixed; inset: 0; z-index: 2147483200; display: flex; align-items: center; justify-content: center; background: var(--backdrop); padding: 16px; }
.cover.plain { background: var(--bg); }
.cover-card { background: var(--bg); border-radius: 8px; box-shadow: var(--shadow); padding: 20px; max-width: 360px; width: 100%; }
.cover.plain .cover-card { box-shadow: none; text-align: center; }
.cover-title { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
.cover-detail { margin: 0 0 16px; color: var(--sub-2); }
.cover.plain .cover-detail { margin: 0; }
.strip { position: fixed; top: 0; left: 0; right: 0; height: 26px; z-index: 2147483150; display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--mantle); border-bottom: 1px solid var(--border); color: var(--sub-2); font-size: 12px; }
.spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--primary); animation: spin 0.8s linear infinite; }
.cover.plain .spinner { margin: 0 auto 12px; width: 18px; height: 18px; }
@keyframes spin { to { transform: rotate(360deg); } }

.panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483050; width: min(400px, calc(100vw - 32px)); background: var(--bg); box-shadow: var(--shadow); border-radius: 8px; }
.panel .modal-body { padding-top: 2px; }
.code { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
.code code { flex: 1; min-width: 0; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--surface); border-radius: 4px; padding: 5px 8px; overflow-x: auto; white-space: nowrap; }
@media (max-width: 520px) {
  .list { height: 46dvh; }
  .modal-foot { flex-wrap: wrap; }
  .crumb { max-width: 120px; }
  .seg { display: flex; flex-direction: column; width: 100%; }
  .seg button { height: auto; min-height: 36px; padding: 6px 12px; text-align: left; white-space: normal; }
  .seg button + button { border-left: 0; border-top: 1px solid var(--border-strong); }
  .toasts { left: 8px; right: 8px; bottom: 32px; max-width: none; }
  .panel { left: 8px; right: 8px; bottom: 32px; width: auto; max-height: calc(100dvh - 48px); overflow-y: auto; }
  .toast { flex-direction: column; gap: 6px; }
  .toast .actions { align-self: flex-end; }
  .modal { max-height: calc(100dvh - 16px); }
  .backdrop { padding: 8px; }
}
/* Touch screens: fingers, not cursors. */
@media (pointer: coarse) {
  .row { height: 42px; }
  .btn { height: 38px; padding: 0 14px; }
  .btn.icon { width: 38px; }
  .crumb { padding: 8px 8px; }
  .input { height: 40px; font-size: 16px; }
}
.selection { margin-top: 6px; color: var(--sub-2); overflow-wrap: anywhere; }
.selection strong { color: var(--text); font-weight: 500; }
`;

  const ICONS = {
    folder: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>',
    file: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/>',
    up: '<path d="M12 5l0 14"/><path d="M18 11l-6 -6"/><path d="M6 11l6 -6"/>',
    upload: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 9l5 -5l5 5"/><path d="M12 4l0 12"/>',
    plus: '<path d="M12 5l0 14"/><path d="M5 12l14 0"/>',
    x: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
    chevron: '<path d="M9 6l6 6l-6 6"/>',
    external: '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/>'
  };

  const icon = (name, size = 16) => {
    const span = document.createElement('span');
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span.firstChild;
  };

  const h = (tag, props, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  };

  let shadow = null;
  let layer = null;
  const isDark = () => document.documentElement.classList.contains('dark');

  const mount = () => {
    if (layer) return layer;
    const host = document.createElement('bruno-web-ui');
    host.style.cssText = 'position: fixed; z-index: 2147483000; top: 0; left: 0; width: 0; height: 0;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('style', { text: STYLE }));
    layer = h('div', { class: `layer${isDark() ? ' dark' : ''}` });
    shadow.appendChild(layer);
    (document.body || document.documentElement).appendChild(host);
    new MutationObserver(() => layer.classList.toggle('dark', isDark()))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return layer;
  };

  // Keep Tab inside a modal: focus must not wander into the page behind it,
  // where Bruno's shortcuts would act.
  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const trapFocus = (e, container) => {
    const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const active = shadow.activeElement;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  // Keyboard events inside our dialogs must not reach Bruno's global hotkeys.
  const isolateKeys = (el) => {
    for (const type of ['keydown', 'keyup', 'keypress']) el.addEventListener(type, (e) => e.stopPropagation());
  };

  /**
   * modal({ title, body, footer, onCancel, wide }) — body is an element,
   * footer an array of elements. Escape and the backdrop call onCancel.
   */
  const modal = ({ title, body, footer, onCancel, wide, labelledBy }) => {
    const root = mount();
    const titleId = `bw-title-${Math.random().toString(36).slice(2)}`;
    const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy || titleId },
      h('div', { class: 'modal-head' },
        h('div', { class: 'modal-title', id: titleId, text: title }),
        h('button', { class: 'btn ghost icon', 'aria-label': t('cancel'), onClick: () => onCancel && onCancel() }, icon('x'))
      ),
      h('div', { class: 'modal-body' }, body),
      footer && footer.length ? h('div', { class: 'modal-foot' }, footer) : null
    );
    const backdrop = h('div', { class: 'backdrop', onMousedown: (e) => { if (e.target === backdrop && onCancel) onCancel(); } }, box);
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && onCancel) {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Tab') {
        trapFocus(e, box);
      }
    });
    isolateKeys(backdrop);
    const previouslyFocused = document.activeElement;
    root.appendChild(backdrop);
    return {
      root: box,
      close() {
        backdrop.remove();
        if (previouslyFocused && previouslyFocused.focus) {
          try { previouslyFocused.focus(); } catch (e) {}
        }
      }
    };
  };

  const toast = (message, { level = 'info', title, actions = [], timeout = 6000 } = {}) => {
    const root = mount();
    let stack = root.querySelector('.toasts');
    if (!stack) {
      stack = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      root.appendChild(stack);
    }
    const close = () => el.remove();
    const el = h('div', { class: `toast ${level}` },
      h('div', { class: 'msg' }, title ? h('span', { class: 'ttl', text: title }) : null, message ? h('span', { text: message }) : null),
      h('div', { class: 'actions' },
        actions.map((a) => h('button', { class: 'btn ghost', onClick: () => { a.onClick(); close(); } }, a.label)),
        h('button', { class: 'btn ghost icon', 'aria-label': t('cancel'), onClick: close }, icon('x', 14))
      )
    );
    stack.appendChild(el);
    if (timeout) setTimeout(close, timeout);
    return close;
  };

  let coverEl = null;
  /** Connection state: null | 'connecting' | 'reconnecting' | 'reloading' | 'taken-over' | 'auth-expired' */
  const connectionState = (state, { onAction } = {}) => {
    const root = mount();
    if (coverEl) {
      coverEl.remove();
      coverEl = null;
    }
    if (!state) return;
    if (state === 'reconnecting') {
      coverEl = h('div', { class: 'strip', role: 'status' }, h('div', { class: 'spinner' }), t('reconnecting'));
    } else if (state === 'connecting' || state === 'reloading') {
      coverEl = h('div', { class: 'cover plain', role: 'status' },
        h('div', { class: 'cover-card' }, h('div', { class: 'spinner' }), h('p', { class: 'cover-detail', text: t(state) })));
    } else {
      const title = state === 'taken-over' ? t('takenOver') : t('authExpired');
      const detail = state === 'taken-over' ? t('takenOverDetail') : t('authExpiredDetail');
      const label = state === 'taken-over' ? t('useHere') : t('signIn');
      coverEl = h('div', { class: 'cover', role: 'alertdialog', 'aria-modal': 'true' },
        h('div', { class: 'cover-card' },
          h('p', { class: 'cover-title', text: title }),
          h('p', { class: 'cover-detail', text: detail }),
          h('button', { class: 'btn primary', onClick: () => onAction && onAction() }, label)));
      isolateKeys(coverEl);
    }
    root.appendChild(coverEl);
    const btn = coverEl.querySelector('button');
    if (btn) btn.focus();
  };

  const panel = ({ title, body, footer, onCancel }) => {
    const root = mount();
    const el = h('div', { class: 'panel', role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' },
        h('div', { class: 'modal-title', text: title }),
        h('button', { class: 'btn ghost icon', 'aria-label': t('cancel'), onClick: () => onCancel && onCancel() }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && onCancel) {
        e.preventDefault();
        onCancel();
      }
    });
    isolateKeys(el);
    root.appendChild(el);
    return { root: el, close: () => el.remove() };
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  window.BrunoWebUI = { h, icon, modal, toast, panel, connectionState, formatSize, mount };
})();
