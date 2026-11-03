import type { AiAccessApproval } from '@shared/aiAccessTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { AiAccessApprovalHost } from './AiAccessApprovalHost';

/**
 * The window that asks the user about something an AI agent wants to do in Runova. One approval
 * shows at a time, in the order they arrived. Secrets stay hidden until the user asks to see them,
 * Deny has the focus so a stray Enter never allows anything, and closing the window counts as Deny.
 */

const NOW = Date.now();

const envEdit: AiAccessApproval = {
  id: 'a1',
  tool: 'env_save_file',
  toolTitle: 'Save an env file',
  area: 'environments',
  risk: 'sensitive',
  agent: 'Claude Code',
  callerKind: 'runova',
  projectId: 'p1',
  projectName: 'Shop',
  preview: {
    title: 'Update .env.local in Staging',
    summary: 'Replaces the whole file with the content the agent sent.',
    fields: [
      { label: 'Environment', value: 'Staging' },
      { label: 'Token', value: 'tok_live_123', secret: true },
    ],
    diff: {
      fileName: '.env.local',
      before: 'API_URL=https://old.test\nAPI_KEY=old-secret',
      after: 'API_URL=https://new.test\nAPI_KEY=old-secret\nDEBUG=true',
      secret: true,
    },
  },
  createdAt: NOW,
  expiresAt: NOW + 240_000,
  cliFallback: false,
};

const request: AiAccessApproval = {
  ...envEdit,
  id: 'a2',
  tool: 'api_execute_request',
  toolTitle: 'Send a request',
  area: 'apiClient',
  agent: 'Codex',
  callerKind: 'external',
  preview: {
    title: 'Send Login',
    request: {
      method: 'POST',
      url: 'https://api.shop.test/login',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: '{"email":"a@b.c"}',
    },
  },
};

function renderHost(pending: AiAccessApproval[]) {
  const view = renderWithProviders(<AiAccessApprovalHost />, {
    bridge: {
      'aiAccess.pendingApprovals': async () => pending,
      'aiAccess.decide': async () => true,
    },
  });
  const announce = (next: AiAccessApproval[]) =>
    act(() => view.bridge.$emit('aiAccess.onApprovalsChanged', next));
  return { ...view, announce };
}

describe('AiAccessApprovalHost', () => {
  it('shows nothing while no approval is waiting', async () => {
    const { bridge } = renderHost([]);

    await waitFor(() => expect(bridge.$fn('aiAccess.pendingApprovals')).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says which agent wants what, on which project, and how sensitive it is', async () => {
    renderHost([envEdit]);

    const dialog = await screen.findByRole('dialog', { name: 'Update .env.local in Staging' });
    expect(within(dialog).getByText('Claude Code')).toBeTruthy();
    expect(within(dialog).getByText('in a Runova tab')).toBeTruthy();
    expect(within(dialog).getByText('Shop')).toBeTruthy();
    expect(within(dialog).getByText('Sensitive')).toBeTruthy();
    expect(within(dialog).getByText('Save an env file')).toBeTruthy();
    expect(within(dialog).getByText(/Replaces the whole file/)).toBeTruthy();
  });

  it('keeps secret values hidden until the user chooses to see them', async () => {
    const { user } = renderHost([envEdit]);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByText(/tok_live_123/)).toBeNull();
    expect(within(dialog).queryByText(/new\.test/)).toBeNull();
    expect(within(dialog).getByText('+2')).toBeTruthy();
    expect(within(dialog).getByText('−1')).toBeTruthy();
    expect(within(dialog).getAllByText('DEBUG=••••••').length).toBe(1);

    await user.click(within(dialog).getByRole('button', { name: 'Show values' }));

    expect(within(dialog).getByText('tok_live_123')).toBeTruthy();
    expect(within(dialog).getByText('API_URL=https://new.test')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Hide values' })).toBeTruthy();
  });

  it('shows an HTTP request with its method, address, headers and body', async () => {
    renderHost([request]);

    const dialog = await screen.findByRole('dialog', { name: 'Send Login' });
    expect(within(dialog).getByText('POST')).toBeTruthy();
    expect(within(dialog).getByText('https://api.shop.test/login')).toBeTruthy();
    expect(within(dialog).getByText('Content-Type')).toBeTruthy();
    expect(within(dialog).getByText('{"email":"a@b.c"}')).toBeTruthy();
    expect(within(dialog).getByText('in another app')).toBeTruthy();
  });

  it('puts the focus on Deny, so a stray Enter allows nothing', async () => {
    renderHost([envEdit]);
    const dialog = await screen.findByRole('dialog');

    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deny' })).toHaveFocus());
  });

  it('sends each answer to Runova', async () => {
    const { user, bridge } = renderHost([envEdit]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /^Allow$/ }));
    expect(bridge.$fn('aiAccess.decide')).toHaveBeenLastCalledWith('a1', 'allow');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('allows a tool for the rest of the session', async () => {
    const { user, bridge } = renderHost([envEdit]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Allow for this session' }));
    expect(bridge.$fn('aiAccess.decide')).toHaveBeenLastCalledWith('a1', 'allow_session');
  });

  it('allows with Ctrl+Enter', async () => {
    const { user, bridge } = renderHost([envEdit]);
    await screen.findByRole('dialog');

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(bridge.$fn('aiAccess.decide')).toHaveBeenLastCalledWith('a1', 'allow');
  });

  it('counts closing the window as Deny', async () => {
    const { user, bridge } = renderHost([envEdit]);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    expect(bridge.$fn('aiAccess.decide')).toHaveBeenLastCalledWith('a1', 'deny');
  });

  it('shows one at a time with the queue length, and follows the list Runova announces', async () => {
    const { announce } = renderHost([envEdit, request]);

    const dialog = await screen.findByRole('dialog', { name: 'Update .env.local in Staging' });
    expect(within(dialog).getByText('1 of 2')).toBeTruthy();

    announce([request]);
    expect(await screen.findByRole('dialog', { name: 'Send Login' })).toBeTruthy();
    expect(screen.queryByText('1 of 2')).toBeNull();

    announce([]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('explains why it asks here when the user chose to be asked in the CLI', async () => {
    renderHost([{ ...envEdit, cliFallback: true }]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/can't show approvals/)).toBeTruthy();
  });
});
