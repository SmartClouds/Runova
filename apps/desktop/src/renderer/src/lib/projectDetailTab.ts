/**
 * The tab a project's details page had open, kept so that coming back to a bare
 * `/projects/<id>` (the Workspace's Project details button, the palette, a project card) opens
 * the same tab again rather than Overview. An address that says anything of its own always wins,
 * which covers a link to a tab and the one-shot params (`edit`, `createRun`).
 */

/** The part of the address worth remembering, or null on Overview (nothing to restore). */
export function rememberable(params: URLSearchParams): string | null {
  const tab = params.get('tab');
  if (!tab) return null;
  const kept = new URLSearchParams();
  kept.set('tab', tab);
  // The sub-tab of Prompts and Monitoring. It only means something next to its tab.
  const view = params.get('view');
  if (view) kept.set('view', view);
  return kept.toString();
}

/** The address to open in place of one that has no params at all, or null to leave it. */
export function restoreTarget(
  params: URLSearchParams,
  remembered: string | null,
): URLSearchParams | null {
  if (!remembered) return null;
  if (params.size > 0) return null;
  const kept = rememberable(new URLSearchParams(remembered));
  return kept ? new URLSearchParams(kept) : null;
}
