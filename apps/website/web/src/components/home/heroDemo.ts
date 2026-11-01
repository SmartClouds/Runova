/**
 * Replays the hero's scripted run once (see HeroDemo.astro). The CSS does the lines and chips from
 * `data-state="playing"`; this file starts it when the hero is first on screen, keeps the status
 * bar's summary in step, counts the token meter up (the count-up idea from React Bits,
 * https://reactbits.dev, written from scratch), and sets `data-state="done"` at the end.
 *
 * States on `[data-hero]`: `idle` (server render, the finished run), `playing`, `done`. With
 * reduced motion it goes straight to `done` and nothing moves.
 */
import {
  DEMO_COST_CENTS,
  DEMO_LENGTH,
  DEMO_PANES,
  DEMO_TOKENS,
  formatCost,
  formatTokens,
  statusCounts,
  statusSummary,
} from '../../lib/heroDemo';

/** Seconds before the run starts, matching `--lead` in HeroDemo.astro. */
const LEAD = 0.7;
/** The extra time after the last line before the run counts as done (the Commit button lands). */
const TAIL = 0.8;

export function playHeroDemo(hero: HTMLElement) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) {
    hero.dataset.state = 'done';
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    start(hero);
  });
  observer.observe(hero);
}

function start(hero: HTMLElement) {
  const summary = hero.querySelector<HTMLElement>('[data-demo-summary]');
  const dot = hero.querySelector<HTMLElement>('[data-demo-dot]');
  const tokens = hero.querySelector<HTMLElement>('[data-demo-tokens]');
  const cost = hero.querySelector<HTMLElement>('[data-demo-cost]');

  const showStatus = (seconds: number) => {
    if (summary) summary.textContent = statusSummary(seconds);
    dot?.classList.toggle('demo-dot-waiting', statusCounts(seconds).waiting > 0);
  };

  showStatus(0);
  if (tokens) tokens.textContent = formatTokens(0);
  if (cost) cost.textContent = formatCost(0);
  hero.dataset.state = 'playing';

  // The summary changes only when an agent's status does.
  const changes = [...new Set(DEMO_PANES.flatMap((pane) => pane.status?.endAt ?? []))];
  for (const at of changes) {
    window.setTimeout(() => showStatus(at), (LEAD + at) * 1000);
  }

  // The meter eases out toward its total over the run.
  const begin = performance.now() + LEAD * 1000;
  const span = DEMO_LENGTH * 1000;
  const tick = (now: number) => {
    const progress = Math.min(1, Math.max(0, (now - begin) / span));
    const eased = 1 - (1 - progress) ** 2;
    if (tokens) tokens.textContent = formatTokens(Math.round((DEMO_TOKENS * eased) / 100) * 100);
    if (cost) cost.textContent = formatCost(Math.round(DEMO_COST_CENTS * eased));
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.setTimeout(
    () => {
      // A hidden tab stops animation frames, so the meter may not have finished on its own.
      showStatus(DEMO_LENGTH);
      if (tokens) tokens.textContent = formatTokens(DEMO_TOKENS);
      if (cost) cost.textContent = formatCost(DEMO_COST_CENTS);
      hero.dataset.state = 'done';
    },
    (LEAD + DEMO_LENGTH + TAIL) * 1000,
  );
}
