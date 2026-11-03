import { describe, expect, it, vi } from 'vitest';
import type { AiAccessApproval } from '../../shared/aiAccessTypes';
import { createApprovalAttention } from './attention';

/**
 * An agent waiting on an approval while Runova is in the background would wait for nothing, so a
 * new approval flashes the window and shows an OS notification. Once per approval, and only while
 * the window is not in front.
 */

const approval = (id: string): AiAccessApproval => ({
  id,
  tool: 'env_save_file',
  toolTitle: 'Save an env file',
  area: 'environments',
  risk: 'sensitive',
  agent: 'Claude Code',
  callerKind: 'runova',
  projectId: 'p1',
  projectName: 'Shop',
  preview: { title: 'Update .env.local' },
  createdAt: 0,
  expiresAt: 1,
  cliFallback: false,
});

function setup(focused: boolean) {
  const deps = {
    isFocused: vi.fn(() => focused),
    flash: vi.fn(),
    notify: vi.fn(),
  };
  return { deps, announce: createApprovalAttention(deps) };
}

describe('approval attention', () => {
  it('flashes and notifies once for each new approval while Runova is in the background', () => {
    const { deps, announce } = setup(false);

    announce([approval('a')]);
    announce([approval('a')]);
    announce([approval('a'), approval('b')]);

    expect(deps.flash).toHaveBeenCalledTimes(2);
    expect(deps.notify).toHaveBeenCalledTimes(2);
    expect(deps.notify).toHaveBeenCalledWith({
      title: 'Claude Code is waiting for you',
      body: 'Update .env.local (Shop)',
    });
  });

  it('stays quiet while Runova is in front, where the dialog already shows', () => {
    const { deps, announce } = setup(true);

    announce([approval('a')]);

    expect(deps.flash).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('forgets approvals that were answered', () => {
    const { deps, announce } = setup(false);

    announce([approval('a')]);
    announce([]);
    announce([approval('a')]);

    expect(deps.notify).toHaveBeenCalledTimes(2);
  });
});
