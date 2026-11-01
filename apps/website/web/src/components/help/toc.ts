/**
 * The help article's "On this page" list follows the reader. The entry for the section being read
 * gets a soft highlight that slides from entry to entry as the page scrolls, a bright segment on the
 * rail beside it, and a fill along the rail for the part already read. Moving down, the bottom edge
 * leads and the top catches up a moment later (and the other way round going up), so the highlight
 * stretches a little as it travels. The look is in HelpToc.astro.
 *
 * Without JavaScript the list is a plain list of links. With reduced motion the highlight jumps.
 */

/** Edges of the active entry, measured inward from each side of the track. */
export interface Frame {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The index of the section being read: the last heading whose top has passed `line` (pixels from
 * the top of the viewport). At the very bottom of the page the last section wins, since a short
 * last section may never reach the line. Before the first heading nothing is active (-1).
 */
export function activeSection(tops: readonly number[], line: number, atBottom: boolean): number {
  if (tops.length === 0) return -1;
  if (atBottom) return tops.length - 1;
  let active = -1;
  for (const [index, top] of tops.entries()) {
    if (top > line) break;
    active = index;
  }
  return active;
}

/** Where the reading line sits: about a third of the way down, but below the sticky header. */
export function readingLine(viewportHeight: number): number {
  return Math.max(112, Math.min(viewportHeight * 0.3, 260));
}

/** The active entry's edges inside the track, from their two bounding boxes. */
export function frameFor(track: DOMRectReadOnly, entry: DOMRectReadOnly): Frame {
  return {
    top: entry.top - track.top,
    right: track.right - entry.right,
    bottom: track.bottom - entry.bottom,
    left: entry.left - track.left,
  };
}

/**
 * How far to scroll the list so the active entry sits in its middle, or null when the entry is
 * already comfortably in view. `offset` is the entry's top inside the scroller's content.
 */
export function scrollTarget(
  offset: number,
  height: number,
  scrollTop: number,
  viewHeight: number,
  margin = 32,
): number | null {
  const inView = offset - margin >= scrollTop && offset + height + margin <= scrollTop + viewHeight;
  if (inView) return null;
  return Math.max(0, offset - (viewHeight - height) / 2);
}

export function setUpToc(nav: HTMLElement) {
  const track = nav.querySelector<HTMLElement>('[data-toc-track]');
  const scroller = nav.querySelector<HTMLElement>('[data-toc-scroll]');
  if (!track || !scroller) return;

  const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[data-toc-link]')];
  const headings = links.map((link) =>
    document.getElementById(decodeURIComponent(link.hash.slice(1))),
  );
  if (links.length === 0 || headings.some((heading) => !heading)) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let active = -1;
  let locked = false;
  let unlockTimer: number | undefined;
  let frame = 0;

  const setEdges = (edges: Frame) => {
    track.style.setProperty('--toc-top', `${edges.top}px`);
    track.style.setProperty('--toc-right', `${edges.right}px`);
    track.style.setProperty('--toc-bottom', `${edges.bottom}px`);
    track.style.setProperty('--toc-left', `${edges.left}px`);
  };

  /** Moves the highlight with no transition: on the first show and when the layout changes. */
  const jump = (edges: Frame) => {
    track.dataset.instant = '';
    setEdges(edges);
    void track.offsetWidth;
    requestAnimationFrame(() => delete track.dataset.instant);
  };

  const keepInView = (link: HTMLElement) => {
    const offset =
      link.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const target = scrollTarget(
      offset,
      link.offsetHeight,
      scroller.scrollTop,
      scroller.clientHeight,
    );
    if (target !== null)
      scroller.scrollTo({ top: target, behavior: reduced.matches ? 'auto' : 'smooth' });
  };

  const updateFades = () => {
    const end = scroller.scrollHeight - scroller.clientHeight;
    scroller.toggleAttribute('data-fade-top', scroller.scrollTop > 1);
    scroller.toggleAttribute('data-fade-bottom', scroller.scrollTop < end - 1);
  };

  const show = (index: number, instant = false) => {
    const previous = active;
    active = index;
    for (const [i, link] of links.entries()) {
      if (i === index) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
      link.toggleAttribute('data-toc-parent', false);
    }
    if (index < 0) {
      delete track.dataset.active;
      return;
    }

    const link = links[index] as HTMLAnchorElement;
    // An h3 lights its h2 a little too, so the reader sees which part they are in.
    if (link.dataset.level === '3') {
      for (let i = index - 1; i >= 0; i--) {
        const candidate = links[i] as HTMLAnchorElement;
        if (candidate.dataset.level !== '3') {
          candidate.toggleAttribute('data-toc-parent', true);
          break;
        }
      }
    }

    const box = track.getBoundingClientRect();
    const edges = frameFor(box, link.getBoundingClientRect());
    if (instant) jump(edges);
    else if (previous < 0) {
      // The first time, the highlight wipes in from the entry's left edge.
      jump({ ...edges, right: box.width - edges.left });
      requestAnimationFrame(() => setEdges(edges));
    } else {
      track.dataset.direction = index > previous ? 'down' : 'up';
      setEdges(edges);
    }
    track.dataset.active = '';
    keepInView(link);
  };

  const measure = () => {
    frame = 0;
    if (locked) return;
    const tops = headings.map((heading) => (heading as HTMLElement).getBoundingClientRect().top);
    const root = document.documentElement;
    const atBottom = window.scrollY + window.innerHeight >= root.scrollHeight - 2;
    const index = activeSection(tops, readingLine(window.innerHeight), atBottom);
    if (index !== active) show(index);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };

  const unlock = () => {
    locked = false;
    window.clearTimeout(unlockTimer);
    schedule();
  };

  // A click picks its entry at once. The spy waits until the smooth scroll ends, so the highlight
  // goes straight there instead of stepping through every section on the way.
  for (const [index, link] of links.entries()) {
    link.addEventListener('click', () => {
      if (index !== active) show(index);
      locked = true;
      window.clearTimeout(unlockTimer);
      unlockTimer = window.setTimeout(unlock, 1000);
      window.addEventListener('scrollend', unlock, { once: true });
    });
  }

  window.addEventListener('scroll', schedule, { passive: true });
  scroller.addEventListener('scroll', updateFades, { passive: true });

  // Text wrapping changes with the width, so put the highlight back without a slide. The observer
  // also reports the first size right away; that one changes nothing.
  let size = '';
  new ResizeObserver(([entry]) => {
    const next = `${entry?.contentRect.width}x${entry?.contentRect.height}`;
    const changed = size !== '' && next !== size;
    size = next;
    updateFades();
    if (!changed) return;
    if (active >= 0) show(active, true);
    schedule();
  }).observe(track);
  window.addEventListener('resize', updateFades, { passive: true });

  updateFades();
  measure();
  nav.dataset.ready = '';
}
