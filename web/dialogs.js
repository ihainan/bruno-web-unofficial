/*
 * Replacements for Electron's native dialogs: a browser for the server's
 * file system (open / save), message boxes, and the OAuth sign-in panel.
 * Each function resolves with the same shape Electron's dialog returns.
 */
(function () {
  const { h, icon, modal, toast, panel, formatSize } = window.BrunoWebUI;
  const { t } = window.BrunoWebI18n;
  const settings = window.__BRUNO_WEB__ || {};
  const sep = settings.sep || '/';

  const api = async (url, init) => {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
    let body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body;
  };

  const touch = window.matchMedia('(pointer: coarse)').matches;

  const listDir = (dir) => api(`/bruno-web/api/fs/list?path=${encodeURIComponent(dir || '')}`);

  const joinPath = (dir, name) => (dir.endsWith(sep) ? dir + name : dir + sep + name);
  const dirname = (p) => {
    const i = p.lastIndexOf(sep);
    return i <= 0 ? sep : p.slice(0, i);
  };
  const basename = (p) => p.slice(p.lastIndexOf(sep) + 1);

  const extensionsOf = (filters) => {
    if (!Array.isArray(filters) || !filters.length) return null;
    const exts = [];
    for (const f of filters) for (const e of f.extensions || []) exts.push(String(e).toLowerCase());
    if (!exts.length || exts.includes('*')) return null;
    return exts;
  };
  const matchesFilter = (name, exts) => !exts || exts.some((e) => name.toLowerCase().endsWith(`.${e}`));

  const uploadInto = async (dir, file, overwrite) => {
    const url = `/bruno-web/api/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`;
    return api(url, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
  };

  /**
   * The shared browser. mode: 'file' | 'dir' | 'save'.
   * Resolves { canceled, paths } (open) or { canceled, mode, filePath | fileName } (save).
   */
  const browse = (params, mode) => new Promise((resolve) => {
    const props = params.properties || [];
    const multi = props.includes('multiSelections');
    const exts = extensionsOf(params.filters);
    const roots = params.roots && params.roots.length ? params.roots : settings.roots || [];

    let current = null;
    let listing = null;
    let selected = new Set();
    let saveTarget = 'download';
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(result);
    };
    const cancel = () => finish(mode === 'save' ? { canceled: true } : { canceled: true, paths: [] });

    const status = h('div', { class: 'status', role: 'status' });
    const setStatus = (text, isError) => {
      status.textContent = text || '';
      status.classList.toggle('error', !!isError);
    };

    const crumbs = h('div', { class: 'crumbs' });
    const upBtn = h('button', { class: 'btn ghost icon', 'aria-label': t('up'), title: t('up'), onClick: () => listing && listing.parent && load(listing.parent) }, icon('up'));
    const list = h('div', { class: 'list', role: 'listbox', 'aria-multiselectable': multi ? 'true' : 'false', tabindex: '-1' });

    const nameInput = h('input', { class: 'input', type: 'text', 'aria-label': t('fileName'), value: params.defaultPath ? basename(params.defaultPath) : '' });
    const confirmBtn = h('button', { class: 'btn primary' });
    const newFolderBtn = h('button', { class: 'btn ghost', onClick: () => promptNewFolder() }, icon('plus', 14), t('newFolder'));
    const fileInput = h('input', { type: 'file', style: 'display:none', multiple: multi ? true : null });
    const uploadBtn = h('button', { class: 'btn ghost', onClick: () => fileInput.click() }, icon('upload', 14), t('upload'));

    const browsing = () => mode !== 'save' || saveTarget === 'server';

    const updateConfirm = () => {
      if (mode === 'save') {
        confirmBtn.textContent = saveTarget === 'download' ? t('downloadShort') : t('save');
        confirmBtn.disabled = !nameInput.value.trim() || (saveTarget === 'server' && !current);
      } else if (mode === 'dir') {
        confirmBtn.textContent = selected.size ? (params.buttonLabel || t('selectFolder')) : t('selectThisFolder');
        confirmBtn.disabled = !current;
      } else {
        confirmBtn.textContent = params.buttonLabel || t('open');
        confirmBtn.disabled = selected.size === 0;
      }
    };

    const renderCrumbs = () => {
      crumbs.innerHTML = '';
      if (!listing) return;
      const root = listing.root;
      const rel = listing.path.slice(root.length).split(sep).filter(Boolean);
      const parts = [{ label: basename(root.replace(/[\\/]+$/, '')) || root, path: root }];
      let acc = root;
      for (const r of rel) {
        acc = joinPath(acc, r);
        parts.push({ label: r, path: acc });
      }
      parts.forEach((p, i) => {
        if (i) crumbs.appendChild(h('span', { class: 'crumb-sep' }, icon('chevron', 12)));
        const last = i === parts.length - 1;
        crumbs.appendChild(h('button', {
          class: `crumb${last ? ' current' : ''}`,
          title: p.path,
          'aria-current': last ? 'location' : null,
          onClick: () => !last && load(p.path)
        }, p.label));
      });
      upBtn.disabled = !listing.parent;
    };

    const entryAllowed = (e) => {
      if (e.type === 'dir') return true;
      if (mode === 'dir') return false;
      return matchesFilter(e.name, exts);
    };

    const renderList = () => {
      list.innerHTML = '';
      if (!listing) return;
      const entries = listing.entries.filter((e) => e.type === 'dir' || mode !== 'dir');
      if (!entries.length) {
        list.appendChild(h('div', { class: 'empty', text: t('emptyFolder') }));
        return;
      }
      for (const e of entries) {
        const full = joinPath(listing.path, e.name);
        const allowed = entryAllowed(e);
        const selectable = mode === 'dir' ? e.type === 'dir' : mode === 'file' ? e.type === 'file' && allowed : e.type === 'file';
        const row = h('div', {
          class: `row ${e.type}${selected.has(full) ? ' selected' : ''}${allowed ? '' : ' disabled'}`,
          role: 'option',
          tabindex: '0',
          'aria-selected': selected.has(full) ? 'true' : 'false',
          title: e.name
        },
        icon(e.type === 'dir' ? 'folder' : 'file'),
        h('span', { class: 'name', text: e.name }),
        e.type === 'file' ? h('span', { class: 'meta', text: formatSize(e.size) }) : null);

        const activate = () => {
          if (e.type === 'dir') return load(full);
          if (mode === 'save') {
            nameInput.value = e.name;
            updateConfirm();
            return confirm();
          }
          if (selectable) {
            selected = new Set([full]);
            confirm();
          }
        };
        row.addEventListener('click', (ev) => {
          // Touch screens have no reliable double tap: a tap opens a folder, and
          // the footer button picks the folder being shown.
          if (touch && e.type === 'dir') return load(full);
          if (mode === 'save') {
            if (e.type === 'file') {
              nameInput.value = e.name;
              updateConfirm();
            }
            return;
          }
          if (!selectable) return;
          if (multi && (ev.metaKey || ev.ctrlKey)) {
            if (selected.has(full)) selected.delete(full);
            else selected.add(full);
          } else {
            selected = new Set([full]);
          }
          renderList();
          updateConfirm();
          const again = list.querySelector(`[title="${CSS.escape(e.name)}"]`);
          if (again) again.focus();
        });
        row.addEventListener('dblclick', activate);
        row.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            activate();
          } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            const sib = ev.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
            if (sib) sib.focus();
          } else if (ev.key === ' ' && selectable && mode !== 'save') {
            ev.preventDefault();
            if (multi && selected.has(full)) selected.delete(full);
            else if (multi) selected.add(full);
            else selected = new Set([full]);
            renderList();
            updateConfirm();
            const again = list.querySelector(`[title="${CSS.escape(e.name)}"]`);
            if (again) again.focus();
          } else if (ev.key === 'Backspace' && listing.parent) {
            ev.preventDefault();
            load(listing.parent);
          }
        });
        list.appendChild(row);
      }
    };

    const load = async (dir) => {
      setStatus('');
      try {
        listing = await listDir(dir);
        current = listing.path;
        selected = new Set();
        renderCrumbs();
        renderList();
        updateConfirm();
        const first = list.querySelector('.row');
        if (first && mode !== 'save') first.focus();
      } catch (err) {
        setStatus(t('loadFailed', { error: err.message }), true);
        if (!listing && dir !== roots[0]) load(roots[0]);
      }
    };

    const confirm = async () => {
      if (confirmBtn.disabled) return;
      if (mode === 'save') {
        const name = nameInput.value.trim();
        if (!name || /[\\/]/.test(name)) return;
        if (saveTarget === 'download') return finish({ canceled: false, mode: 'download', fileName: name });
        const target = joinPath(current, name);
        if (listing.entries.some((e) => e.name === name)) {
          const answer = await messageBox({ type: 'warning', message: t('overwrite', { name }), buttons: [t('save'), t('cancel')], cancelId: 1 });
          if (answer.response !== 0) return;
        }
        return finish({ canceled: false, mode: 'server', filePath: target });
      }
      if (mode === 'dir') {
        const chosen = selected.size ? [...selected] : [current];
        return finish({ canceled: false, paths: chosen });
      }
      finish({ canceled: false, paths: [...selected] });
    };
    confirmBtn.addEventListener('click', confirm);

    const promptNewFolder = () => {
      const input = h('input', { class: 'input', type: 'text', 'aria-label': t('newFolderName') });
      const err = h('div', { class: 'status error' });
      let inner;
      const create = async () => {
        const name = input.value.trim();
        if (!name || /[\\/]/.test(name)) return;
        try {
          const made = await api(`/bruno-web/api/fs/mkdir?path=${encodeURIComponent(joinPath(current, name))}`, { method: 'POST' });
          inner.close();
          await load(current);
          if (mode === 'dir') {
            selected = new Set([made.path]);
            renderList();
            updateConfirm();
          }
        } catch (e) {
          err.textContent = e.message;
        }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
      inner = modal({
        title: t('newFolder'),
        body: h('div', {}, h('label', { class: 'label', text: t('newFolderName') }), input, err),
        footer: [h('div', { class: 'spacer' }), h('button', { class: 'btn', onClick: () => inner.close() }, t('cancel')), h('button', { class: 'btn primary', onClick: create }, t('create'))],
        onCancel: () => inner.close()
      });
      input.focus();
    };

    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      // Fixed at selection time: the user may browse elsewhere while uploading.
      const targetDir = current;
      const existing = new Set(listing.entries.map((e) => e.name));
      const uploaded = [];
      for (const file of files) {
        setStatus(t('uploading', { name: file.name }));
        try {
          let overwrite = false;
          if (existing.has(file.name)) {
            const answer = await messageBox({ type: 'warning', message: t('overwrite', { name: file.name }), buttons: [t('save'), t('cancel')], cancelId: 1 });
            if (answer.response !== 0) continue;
            overwrite = true;
          }
          const res = await uploadInto(targetDir, file, overwrite);
          uploaded.push(res.path);
        } catch (err) {
          setStatus(t('uploadFailed', { error: err.message }), true);
          return;
        }
      }
      setStatus('');
      if (done || current !== targetDir) return;
      await load(targetDir);
      if (mode === 'file' && uploaded.length) {
        selected = new Set(multi ? uploaded : uploaded.slice(-1));
        renderList();
        updateConfirm();
      }
    });

    nameInput.addEventListener('input', updateConfirm);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });

    const browser = h('div', {},
      h('div', { class: 'bar' }, upBtn, crumbs),
      list,
      status);

    const parts = [];
    if (mode === 'save') {
      const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('saveTarget') });
      const setTarget = (target) => {
        saveTarget = target;
        for (const b of seg.children) {
          const on = b.dataset.target === target;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        browser.style.display = target === 'server' ? '' : 'none';
        newFolderBtn.style.display = target === 'server' ? '' : 'none';
        if (target === 'server' && !listing) load(params.defaultPath ? dirname(params.defaultPath) : roots[0]);
        updateConfirm();
      };
      seg.appendChild(h('button', { 'data-target': 'download', role: 'radio', onClick: () => setTarget('download') }, t('saveDownload')));
      seg.appendChild(h('button', { 'data-target': 'server', role: 'radio', onClick: () => setTarget('server') }, t('saveServer')));
      parts.push(
        h('label', { class: 'label', text: t('fileName') }), nameInput,
        h('label', { class: 'label', text: t('saveTarget') }), seg,
        h('div', { style: 'margin-top: 10px' }, browser));
      setTimeout(() => setTarget('download'));
    } else {
      parts.push(browser);
    }

    const footer = [];
    if (mode === 'file') footer.push(uploadBtn, fileInput);
    if (mode === 'dir' || mode === 'save' || props.includes('createDirectory')) footer.push(newFolderBtn);
    footer.push(h('div', { class: 'spacer' }), h('button', { class: 'btn', onClick: cancel }, t('cancel')), confirmBtn);

    const defaultTitle = mode === 'save' ? t('save') : mode === 'dir' ? t('selectFolder') : t('open');
    const dlg = modal({
      title: params.title || defaultTitle,
      body: h('div', {}, params.message ? h('p', { class: 'detail', text: params.message }) : null, ...parts),
      footer,
      onCancel: cancel,
      wide: true
    });

    if (mode !== 'save') {
      const start = params.defaultPath || roots[0];
      load(start);
    } else {
      nameInput.focus();
      nameInput.select();
    }
    updateConfirm();
  });

  const openDialog = async (params) => {
    const props = params.properties || [];
    const mode = props.includes('openDirectory') && !props.includes('openFile') ? 'dir' : 'file';
    const result = await browse(params, mode);
    return { canceled: result.canceled, filePaths: result.paths || [] };
  };

  const saveDialog = (params) => browse(params, 'save');

  const messageBox = (params) => new Promise((resolve) => {
    const buttons = params.buttons && params.buttons.length ? params.buttons : [t('ok')];
    const cancelId = params.cancelId != null ? params.cancelId : buttons.length > 1 ? buttons.length - 1 : 0;
    let check = null;
    let dlg;
    const finish = (response) => {
      dlg.close();
      resolve({ response, checkboxChecked: check ? check.checked : false });
    };
    if (params.checkboxLabel) check = h('input', { type: 'checkbox', checked: params.checkboxChecked ? true : null });
    const btns = buttons.map((label, i) => h('button', {
      class: `btn${i === (params.defaultId ?? 0) ? ' primary' : ''}`,
      onClick: () => finish(i)
    }, label));
    dlg = modal({
      title: params.title || 'Bruno',
      body: h('div', {},
        params.message ? h('p', { class: 'text', text: params.message }) : null,
        params.detail ? h('p', { class: 'detail', text: params.detail }) : null,
        check ? h('label', { class: 'check' }, check, params.checkboxLabel) : null),
      footer: [h('div', { class: 'spacer' }), ...btns.slice().reverse()],
      onCancel: () => finish(cancelId)
    });
    const def = btns[params.defaultId ?? 0];
    if (def) def.focus();
  });

  /**
   * The stand-in for upstream's OAuth BrowserWindow: opens the authorization
   * URL in a popup and lets the user paste the address they ended up on when
   * the callback is not this server.
   */
  const authWindows = new Map();
  const openAuthWindow = ({ window: id, url, callbackUrl }, { navigate, close }) => {
    let popup = null;
    const openPopup = () => {
      if (!/^https?:/i.test(url)) return false;
      popup = window.open(url, `bruno-oauth-${id}`, 'popup,width=520,height=720');
      // The sign-in page is someone else's site: it must not get a handle on Bruno.
      if (popup) {
        try { popup.opener = null; } catch (e) {}
      }
      return !!popup;
    };
    const opened = openPopup();

    const input = h('input', { class: 'input', type: 'url', placeholder: 'https://…', 'aria-label': t('authPasteLabel') });
    const submit = () => {
      const value = input.value.trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return;
      navigate(value);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    let copyBtn = null;
    if (callbackUrl) {
      copyBtn = h('button', { class: 'btn ghost', onClick: async () => {
        try {
          await navigator.clipboard.writeText(callbackUrl);
          copyBtn.textContent = t('copied');
        } catch (e) {}
      } }, t('copy'));
    }

    const p = panel({
      title: t('authTitle'),
      body: h('div', {},
        h('p', { class: 'detail', text: opened ? t('authBody') : t('popupBlocked') }),
        callbackUrl ? h('div', {},
          h('label', { class: 'label', text: t('authCallbackHint') }),
          h('div', { class: 'code' }, h('code', { text: callbackUrl }), copyBtn)) : null,
        h('label', { class: 'label', text: t('authPasteLabel') }),
        input),
      footer: [
        h('button', { class: 'btn ghost', onClick: () => openPopup() }, icon('external', 14), t('authReopen')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onClick: () => close() }, t('cancel')),
        h('button', { class: 'btn primary', onClick: submit }, t('authSubmit'))
      ],
      onCancel: () => close()
    });
    authWindows.set(id, { panel: p, popup: () => popup });
  };

  const closeAuthWindow = (id) => {
    const entry = authWindows.get(id);
    if (!entry) return;
    authWindows.delete(id);
    entry.panel.close();
    const popup = entry.popup();
    try { if (popup && !popup.closed) popup.close(); } catch (e) {}
  };

  const openExternal = (url) => {
    // Not using the `noopener` feature: with it window.open() always returns
    // null, and a blocked popup could not be told apart from a successful one.
    const w = window.open(url, '_blank');
    if (w) {
      try { w.opener = null; } catch (e) {}
    } else {
      toast(url, {
        title: t('popupBlocked'),
        actions: [{ label: t('openLink'), onClick: () => window.open(url, '_blank', 'noopener,noreferrer') }],
        timeout: 12000
      });
    }
  };

  const download = ({ url, name }) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  window.BrunoWebDialogs = { openDialog, saveDialog, messageBox, openAuthWindow, closeAuthWindow, openExternal, download };
})();
