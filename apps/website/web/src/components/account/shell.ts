/**
 * The account layout's small behaviors on phones: the nav strip scrolls the current page into
 * view (or "Teams" sits off-screen on a 360px phone), and the account menu closes on a tap
 * outside it or on Escape, like any other menu.
 */
export function setUpAccountShell(root: Document) {
  const nav = root.querySelector<HTMLElement>('[data-account-nav]');
  const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
  if (nav && current && nav.scrollWidth > nav.clientWidth) {
    nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
  }

  const menu = root.querySelector<HTMLDetailsElement>('[data-account-menu]');
  if (!menu) return;
  root.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });
}
