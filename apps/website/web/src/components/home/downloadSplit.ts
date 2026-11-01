/**
 * The split download button (DownloadSplit.astro). It names the visitor's system on the main
 * link, and runs the menu: the chevron or ArrowDown/ArrowUp opens it, arrows, Home and End move
 * through it, Escape closes it and gives focus back to the chevron, and a click outside closes it.
 * Picking a system downloads that build and makes it the main link.
 *
 * Same behavior as the hero download selector on openbot.run, written from scratch.
 */
import {
  type DesktopArch,
  type DesktopOs,
  type NavigatorSignals,
  systemFromNavigator,
} from '../../lib/download/detect';

const NAMES: Record<DesktopOs, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

/** The link that downloads the latest build for a system. Only an Arm Linux needs its arch. */
export function latestHref(os: DesktopOs, arch: DesktopArch | null = null): string {
  return `/download/${os}/latest${os === 'linux' && arch === 'arm64' ? '?arch=arm64' : ''}`;
}

export function downloadLabel(os: DesktopOs): string {
  return `Download for ${NAMES[os]}`;
}

function isDesktopOs(value: string | undefined): value is DesktopOs {
  return value === 'windows' || value === 'macos' || value === 'linux';
}

function setUpOne(root: HTMLElement, detected: { os: DesktopOs | null; arch: DesktopArch | null }) {
  const primary = root.querySelector<HTMLAnchorElement>('[data-download-primary]');
  const label = root.querySelector<HTMLElement>('[data-download-label]');
  const trigger = root.querySelector<HTMLButtonElement>('[data-download-trigger]');
  const menu = root.querySelector<HTMLElement>('[role="menu"]');
  if (!primary || !label || !trigger || !menu) return;
  const items = [...menu.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]')];

  const choose = (os: DesktopOs, arch: DesktopArch | null) => {
    root.dataset.platform = os;
    primary.href = latestHref(os, arch);
    label.textContent = downloadLabel(os);
    for (const item of items) item.toggleAttribute('data-selected', item.dataset.os === os);
  };

  const isOpen = () => root.dataset.open === 'true';

  const close = (returnFocus = false) => {
    if (!isOpen()) return;
    root.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    if (returnFocus) trigger.focus();
  };

  const open = (focus: 'first' | 'last' | null = null) => {
    root.dataset.open = 'true';
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    if (focus) (focus === 'first' ? items[0] : items.at(-1))?.focus();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.target === trigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 'first' : 'last');
      return;
    }
    if (!isOpen() || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLAnchorElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  if (detected.os) choose(detected.os, detected.arch);

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  trigger.addEventListener('keydown', onKeydown);
  menu.addEventListener('keydown', onKeydown);
  for (const item of items) {
    item.addEventListener('click', () => {
      const os = item.dataset.os;
      if (isDesktopOs(os)) choose(os, os === detected.os ? detected.arch : null);
      close();
    });
  }
  document.addEventListener('pointerdown', (event) => {
    if (isOpen() && event.target instanceof Node && !root.contains(event.target)) close();
  });
  root.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (isOpen() && next instanceof Node && !root.contains(next)) close();
  });
}

export function setUpDownloadSplits(root: ParentNode = document) {
  const detected = systemFromNavigator(navigator as Navigator & NavigatorSignals);
  for (const element of root.querySelectorAll<HTMLElement>('[data-download-split]')) {
    setUpOne(element, detected);
  }
}
