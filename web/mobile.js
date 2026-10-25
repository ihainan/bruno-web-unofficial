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

    const drawer = document.querySelector(DRAWER);
    if (drawer && drawer.contains(target)) {
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
})();
