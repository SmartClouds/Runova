/**
 * The scripted run the home page hero plays: four panes of one workspace, each with an agent (or a
 * shell) working on the same storefront repo. Every line carries the second it appears at; the
 * server renders the finished run, and the hero script replays it once.
 */

export type PaneStatus = 'working' | 'waiting' | 'done';

export type LineTone = 'prompt' | 'tool' | 'muted' | 'add' | 'remove' | 'ok' | 'text' | 'ask';

export interface DemoLine {
  text: string;
  tone: LineTone;
  /** Seconds after the run starts. */
  at: number;
}

export interface DemoPane {
  cli: string;
  /** The pane's folder or worktree, shown next to the name. */
  place: string;
  lines: DemoLine[];
  /** Agents move from working to `end` at `endAt`. A shell has no status. */
  status?: { end: Exclude<PaneStatus, 'working'>; endAt: number };
  /** Shown on phones too. The others appear from the md breakpoint. */
  onPhones: boolean;
}

export const DEMO_PANES: DemoPane[] = [
  {
    cli: 'Claude Code',
    place: 'cart-discounts',
    onPhones: true,
    status: { end: 'done', endAt: 4.4 },
    lines: [
      { text: '> Add discount codes to the cart, never below zero.', tone: 'prompt', at: 0 },
      { text: '● Read(src/lib/price.ts)', tone: 'tool', at: 0.6 },
      { text: '  └ Read 44 lines', tone: 'muted', at: 0.9 },
      { text: '● Update(src/cart/totals.ts)', tone: 'tool', at: 1.5 },
      { text: '  + export function discountedBy(', tone: 'add', at: 1.8 },
      { text: '  - return { subtotalCents, total }', tone: 'remove', at: 2.0 },
      { text: '● Bash(pnpm test src)', tone: 'tool', at: 2.9 },
      { text: '  └ Tests 21 passed (21)', tone: 'ok', at: 3.8 },
      { text: 'Discount codes are in. All 21 tests pass.', tone: 'text', at: 4.4 },
    ],
  },
  {
    cli: 'Codex',
    place: 'checkout-form',
    onPhones: true,
    status: { end: 'waiting', endAt: 2.9 },
    lines: [
      { text: '> Move the checkout form to the new schema.', tone: 'prompt', at: 0.3 },
      { text: '• Edited src/checkout/Form.tsx +38 -21', tone: 'tool', at: 1.1 },
      { text: '• Edited src/db/schema.ts +12', tone: 'tool', at: 1.9 },
      { text: 'Wants to run pnpm db:migrate', tone: 'text', at: 2.6 },
      { text: 'Allow this command?', tone: 'ask', at: 2.9 },
    ],
  },
  {
    cli: 'Gemini',
    place: 'docs',
    onPhones: false,
    status: { end: 'done', endAt: 3.3 },
    lines: [
      { text: '> Document the discount rules in the README.', tone: 'prompt', at: 0.5 },
      { text: '✓ ReadFile README.md', tone: 'tool', at: 1.4 },
      { text: '✓ Edit README.md +18', tone: 'tool', at: 2.3 },
      { text: 'Added a Discounts section with two examples.', tone: 'text', at: 3.3 },
    ],
  },
  {
    cli: 'Shell',
    place: 'storefront',
    onPhones: false,
    lines: [
      { text: '$ pnpm test --watch', tone: 'prompt', at: 0.2 },
      { text: ' RERUN src/cart/totals.ts', tone: 'muted', at: 1.6 },
      { text: ' ✓ src/lib/discounts.test.ts (19)', tone: 'ok', at: 3.7 },
      { text: ' ✓ src/cart/totals.test.ts (2)', tone: 'ok', at: 3.9 },
      { text: ' Test Files 3 passed (3)', tone: 'ok', at: 4.1 },
    ],
  },
];

/** When the run ends: the last status change or line, whichever is later. */
export const DEMO_LENGTH = Math.max(
  ...DEMO_PANES.flatMap((pane) => [...pane.lines.map((line) => line.at), pane.status?.endAt ?? 0]),
);

/** The labels each status shows in its chip and in the status bar. */
export const STATUS_LABEL: Record<PaneStatus, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  done: 'Done',
};

/** How many agents are in each status `seconds` into the run. */
export function statusCounts(seconds: number): Record<PaneStatus, number> {
  const counts: Record<PaneStatus, number> = { working: 0, waiting: 0, done: 0 };
  for (const pane of DEMO_PANES) {
    if (!pane.status) continue;
    counts[seconds >= pane.status.endAt ? pane.status.end : 'working'] += 1;
  }
  return counts;
}

/** The status bar's summary, e.g. "2 done · 1 waiting on you". Empty statuses are left out. */
export function statusSummary(seconds: number): string {
  const counts = statusCounts(seconds);
  return (['working', 'waiting', 'done'] as const)
    .filter((status) => counts[status] > 0)
    .map((status) =>
      status === 'waiting' ? `${counts.waiting} waiting on you` : `${counts[status]} ${status}`,
    )
    .join(' · ');
}

/** The token meter in the status bar counts up to these over the run. */
export const DEMO_TOKENS = 184_200;
export const DEMO_COST_CENTS = 192;

export function formatTokens(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}k tokens`;
}

export function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
