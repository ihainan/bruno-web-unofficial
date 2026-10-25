/*
 * Phone behaviour for the layout in mobile.css: Bruno's sidebar button opens
 * and closes a drawer instead of collapsing the sidebar. Bruno saves its
 * collapsed state to the server-side UI snapshot, so toggling it on a phone
 * would also collapse the sidebar on the user's computer; the drawer state
 * lives only in this page.
 */
(function () {
  // Same condition as the drawer rules in mobile.css.
  const mq = window.matchMedia('(max-width: 1024px) and (pointer: coarse)');
  const root = document.documentElement;

  const DRAWER = '#main-container > .flex-1 > div > div:has(> div > aside[data-testid="sidebar"])';
  const TOGGLE = '[data-testid="toggle-sidebar-button"]';
  // Popups and dialogs opened from inside the drawer render elsewhere in the page.
  const OVERLAYS = '.tippy-box, .bruno-modal, [role="dialog"], [role="alertdialog"], bruno-web-ui';

  let rowMenuOpenedAt = 0;
  const isOpen = () => root.classList.contains('bw-drawer-open');
  const setOpen = (open) => {
    root.classList.toggle('bw-drawer-open', open);
    const toggle = document.querySelector(TOGGLE);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  document.addEventListener('click', (e) => {
    if (!mq.matches) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    if (target.closest(TOGGLE)) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!isOpen());
      return;
    }
    if (!isOpen()) return;

    // Menus may render inside the drawer or elsewhere. An entry picked from a
    // row's menu (settings, rename, run…) acts on the main area or opens a
    // dialog: get the drawer out of the way. The menu's own expanded flag is
    // already cleared when the tap's click arrives, so remember when a row
    // menu was opened instead.
    if (target.closest('.tippy-box')) {
      if (Date.now() - rowMenuOpenedAt < 30000 && target.closest('.dropdown-item')) {
        rowMenuOpenedAt = 0;
        setTimeout(() => setOpen(false));
      }
      return;
    }

    const drawer = document.querySelector(DRAWER);
    if (drawer && drawer.contains(target)) {
      if (target.closest('.collection-actions, .menu-icon, [data-testid="collection-item-menu"]')) {
        rowMenuOpenedAt = Date.now();
        return;
      }
      // Opening a request (not expanding a folder or opening a row's menu)
      // means the user is done with the tree.
      const row = target.closest('.collection-item-name');
      const onControl = target.closest('[data-testid="collection-item-menu"], [data-testid="folder-chevron"], [data-testid="request-item-chevron"]');
      if (row && !onControl && !row.querySelector('[data-testid="folder-chevron"]')) {
        setTimeout(() => setOpen(false));
      }
      return;
    }
    if (target.closest(OVERLAYS)) return;
    // A tap on the dimmed page closes the drawer and does nothing else.
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  }, true);

  // Leaving phone layout (rotation, external display) closes the drawer.
  mq.addEventListener('change', () => { if (!mq.matches) setOpen(false); });

  // Upstream's menus open in a fixed direction; near the bottom of a phone
  // screen they run under the status bar. Cap each one at the space left
  // below its top edge and let it scroll.
  const STATUS_BAR = 32;
  const fitPopup = (root) => {
    const content = root.querySelector('.tippy-content');
    if (!content) return;
    content.style.maxHeight = '';
    const top = content.getBoundingClientRect().top;
    const room = window.innerHeight - STATUS_BAR - top;
    if (content.scrollHeight > room) {
      content.style.maxHeight = `${Math.max(120, room)}px`;
      content.style.overflowY = 'auto';
    }
  };
  new MutationObserver((records) => {
    if (!mq.matches) return;
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.matches('[data-tippy-root]')) requestAnimationFrame(() => requestAnimationFrame(() => fitPopup(n)));
      }
    }
  }).observe(document.body || document.documentElement, { childList: true });
})();
