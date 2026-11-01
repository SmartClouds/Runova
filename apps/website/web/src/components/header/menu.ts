/**
 * The header menu (src/components/Header.astro, styles in header.css).
 *
 * Desktop: hovering a label (one of the menu's, or the Download button) opens its panel on a shared
 * glass surface. Moving to another label
 * slides the surface over and resizes it, while the old panel slides out to one side and the new
 * one in from the other. A label with a link still goes to its page when clicked; Resources is a
 * button and toggles. From the keyboard, ArrowDown opens a panel and moves into it, and Escape
 * closes it and returns to the label.
 *
 * Phones: a round button opens a full-screen sheet with the same panels stacked.
 */

import { loadLatest } from './latest';

/** The panel never comes closer than this to the window edge. */
const EDGE = 16;
/** How long the pointer may be off the menu before it closes. */
const CLOSE_DELAY = 140;
/** The space between a label and its panel. */
const GAP = 10;
export const DESKTOP_QUERY = '(width >= 900px)';

interface Item {
  trigger: HTMLElement;
  panel: HTMLElement | null;
}

type Opener = 'pointer' | 'keyboard' | 'click';

/** Restarts the CSS animation of `panel` with `motion`, even when the value is the same. */
function setMotion(panel: HTMLElement, motion: string) {
  panel.removeAttribute('data-motion');
  void panel.offsetWidth;
  panel.dataset.motion = motion;
}

/** Applies a style change without its transition (the first show of the pill or the surface). */
function instantly(node: HTMLElement, change: () => void) {
  node.dataset.instant = '';
  change();
  void node.offsetWidth;
  delete node.dataset.instant;
}

/**
 * `root` holds every label and the surface. The labels sit in zones (the Main menu and the Download
 * button); the pointer and focus count as in the menu while they are in any zone or its panels.
 */
export function setUpMegaMenu(root: HTMLElement) {
  const track = root.querySelector<HTMLElement>('[data-mega-track]');
  const pill = root.querySelector<HTMLElement>('[data-mega-pill]');
  const surface = root.querySelector<HTMLElement>('[data-mega-surface]');
  if (!track || !pill || !surface) return;
  const zones = [...root.querySelectorAll<HTMLElement>('[data-mega-zone]')];
  const inMenu = (node: Node | null) => node !== null && zones.some((zone) => zone.contains(node));

  const items: Item[] = [...root.querySelectorAll<HTMLElement>('[data-mega-item]')].flatMap(
    (item) => {
      const trigger = item.querySelector<HTMLElement>('[data-mega-trigger]');
      return trigger ? [{ trigger, panel: item.querySelector<HTMLElement>('.mega-panel') }] : [];
    },
  );

  let active: Item | null = null;
  let openedBy: Opener | null = null;
  let closeTimer = 0;
  let pointerOnBar = false;
  let pointerInMenu = false;

  const hidePill = () => pill.removeAttribute('data-shown');

  const movePill = (trigger: HTMLElement) => {
    // Only the menu's labels have the pill; the Download button is filled already.
    if (!track.contains(trigger)) {
      hidePill();
      return;
    }
    const set = () => {
      pill.style.setProperty('--pill-x', `${trigger.offsetLeft}px`);
      pill.style.setProperty('--pill-w', `${trigger.offsetWidth}px`);
    };
    if (pill.hasAttribute('data-shown')) set();
    else instantly(pill, set);
    pill.dataset.shown = '';
  };

  /** Places the panel under its label, inside the window, and sizes the surface to it. */
  const place = (item: Item, change: (apply: () => void) => void = (apply) => apply()) => {
    const { panel, trigger } = item;
    if (!panel) return;
    const rootBox = root.getBoundingClientRect();
    const label = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const center = label.left + label.width / 2;
    const right = document.documentElement.clientWidth - EDGE - width;
    const left = Math.max(EDGE, Math.min(center - width / 2, right));
    // Every label is 32px tall on the same row, so every panel starts at the same height. The
    // menu's labels sit 4px inside their track, so the gap counts from there.
    const top = label.bottom + 4 + GAP;
    const parent = (panel.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? rootBox;
    panel.style.left = `${left - parent.left}px`;
    panel.style.top = `${top - parent.top}px`;
    change(() => {
      surface.style.setProperty('--sx', `${left - rootBox.left}px`);
      surface.style.setProperty('--sy', `${top - rootBox.top}px`);
      surface.style.setProperty('--sw', `${width}px`);
      surface.style.setProperty('--sh', `${panel.offsetHeight}px`);
      surface.style.setProperty('--so', `${center - left}px`);
    });
  };

  const show = (item: Item, open: boolean) => {
    item.trigger.setAttribute('aria-expanded', String(open));
    if (!item.panel) return;
    item.panel.dataset.state = open ? 'open' : 'closed';
    item.panel.inert = !open;
  };

  const close = () => {
    window.clearTimeout(closeTimer);
    if (!active) return;
    if (active.panel) setMotion(active.panel, 'exit');
    show(active, false);
    active = null;
    openedBy = null;
    root.dataset.state = 'closed';
    if (!pointerOnBar) hidePill();
  };

  const open = (item: Item, by: Opener) => {
    window.clearTimeout(closeTimer);
    if (active === item) return;
    if (!item.panel) {
      close();
      return;
    }
    void loadLatest();
    const previous = active;
    if (previous?.panel) {
      const forward = items.indexOf(item) > items.indexOf(previous);
      setMotion(previous.panel, forward ? 'to-start' : 'to-end');
      show(previous, false);
      place(item);
      setMotion(item.panel, forward ? 'from-end' : 'from-start');
    } else {
      place(item, (apply) => instantly(surface, apply));
      setMotion(item.panel, 'enter');
    }
    show(item, true);
    active = item;
    openedBy = by;
    root.dataset.state = 'open';
    movePill(item.trigger);
  };

  const itemOf = (node: EventTarget | null) =>
    node instanceof Node
      ? items.find((item) => item.trigger.parentElement?.contains(node))
      : undefined;

  for (const item of items) {
    item.trigger.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      movePill(item.trigger);
      open(item, 'pointer');
    });

    if (item.trigger instanceof HTMLButtonElement) {
      item.trigger.addEventListener('click', () => {
        // A hover already opened it, so the click that follows keeps it open.
        if (active === item && openedBy !== 'pointer') close();
        else open(item, 'click');
      });
    }

    item.trigger.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' || !item.panel) return;
      event.preventDefault();
      open(item, 'keyboard');
      item.panel.querySelector<HTMLElement>('a')?.focus();
    });
  }

  track.addEventListener('pointerenter', () => {
    pointerOnBar = true;
  });
  track.addEventListener('pointerleave', () => {
    pointerOnBar = false;
    if (active) movePill(active.trigger);
    else hidePill();
  });

  for (const zone of zones) {
    zone.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      pointerInMenu = true;
      void loadLatest();
      window.clearTimeout(closeTimer);
    });
    zone.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      pointerInMenu = false;
      if (openedBy !== 'pointer') return;
      closeTimer = window.setTimeout(close, CLOSE_DELAY);
    });

    // Tabbing onto another label closes the open panel; leaving the menu closes it too.
    zone.addEventListener('focusin', (event) => {
      void loadLatest();
      if (active && itemOf(event.target) !== active) close();
    });
    zone.addEventListener('focusout', (event) => {
      const next = event.relatedTarget as Node | null;
      // A click on the panel's background drops focus to nothing; that is not leaving the menu.
      if (next ? !inMenu(next) : !pointerInMenu) close();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !active) return;
    const { trigger } = active;
    const focusWasInside = inMenu(document.activeElement);
    close();
    if (focusWasInside) trigger.focus();
  });

  document.addEventListener('pointerdown', (event) => {
    if (active && !inMenu(event.target as Node)) close();
  });

  // The newest entries arrive after the panel opens, so the surface follows the new height.
  const resized = new ResizeObserver(() => {
    if (active) place(active);
  });
  for (const item of items) if (item.panel) resized.observe(item.panel);

  addEventListener('resize', () => {
    if (active) place(active);
  });
}

export function setUpSheet(button: HTMLButtonElement, sheet: HTMLElement) {
  const root = document.documentElement;
  const isOpen = () => sheet.dataset.state === 'open';

  const set = (open: boolean) => {
    sheet.dataset.state = open ? 'open' : 'closed';
    sheet.inert = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    root.classList.toggle('sheet-open', open);
    if (open) void loadLatest();
  };

  button.addEventListener('click', () => set(!isOpen()));

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    set(false);
    button.focus();
  });

  // A link in the sheet may point into this page, so the sheet closes on any link.
  sheet.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a')) set(false);
  });

  // Growing past the phone width hides the sheet; it must not stay open and lock the scroll.
  matchMedia(DESKTOP_QUERY).addEventListener('change', (event) => {
    if (event.matches && isOpen()) set(false);
  });
}

export function setUpHeader(header: HTMLElement | null) {
  if (!header) return;
  const root = header.querySelector<HTMLElement>('[data-mega]');
  if (root) setUpMegaMenu(root);
  const button = header.querySelector<HTMLButtonElement>('[data-menu-button]');
  const sheet = header.querySelector<HTMLElement>('[data-sheet]');
  if (button && sheet) setUpSheet(button, sheet);
}
