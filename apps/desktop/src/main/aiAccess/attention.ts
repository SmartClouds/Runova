import type { AiAccessApproval } from '../../shared/aiAccessTypes';

/**
 * An agent waiting on an approval while Runova is in the background would wait for nothing, so a
 * new approval flashes the window and shows an OS notification: once per approval, and only while
 * the window is not in front, where the dialog already shows.
 */
export function createApprovalAttention(deps: {
  isFocused(): boolean;
  flash(): void;
  notify(message: { title: string; body: string }): void;
}): (approvals: AiAccessApproval[]) => void {
  let seen = new Set<string>();
  return (approvals) => {
    const fresh = approvals.filter((one) => !seen.has(one.id));
    seen = new Set(approvals.map((one) => one.id));
    if (fresh.length === 0 || deps.isFocused()) return;
    for (const approval of fresh) {
      deps.flash();
      deps.notify({
        title: `${approval.agent} is waiting for you`,
        body: approval.projectName
          ? `${approval.preview.title} (${approval.projectName})`
          : approval.preview.title,
      });
    }
  };
}
