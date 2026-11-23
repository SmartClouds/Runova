import { formatHostKeyFingerprint, type SshHostKeyStatus } from '@shared/sshHostKey';
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { promptHostKeyTrust, useHostKeyPromptStore } from '../../stores/hostKeyPromptStore';
import { HostKeyChangedDialogHost } from './HostKeyChangedDialog';

/**
 * The moment a server's identity changes is a security decision. The dialog shows exactly what
 * changed, in the form OpenSSH prints it, and only an explicit click trusts the new key.
 */

const status: SshHostKeyStatus = {
  serverId: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 2222,
  stored: 'ab'.repeat(32),
  presented: 'cd'.repeat(32),
};

function ask(overrides: Partial<SshHostKeyStatus> = {}): Promise<boolean> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = promptHostKeyTrust({ ...status, ...overrides });
  });
  return answer;
}

describe('HostKeyChangedDialog', () => {
  it('shows nothing while no server is in question', () => {
    renderWithProviders(<HostKeyChangedDialogHost />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the server and shows both fingerprints the way OpenSSH prints them', () => {
    renderWithProviders(<HostKeyChangedDialogHost />);
    void ask();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('prod');
    expect(dialog).toHaveTextContent('prod.example:2222');
    expect(dialog).toHaveTextContent(formatHostKeyFingerprint(status.stored ?? ''));
    expect(dialog).toHaveTextContent(formatHostKeyFingerprint(status.presented));
    expect(dialog).toHaveTextContent('ssh-keygen -lf');
  });

  it('trusts the new key only on the explicit button', async () => {
    const { user } = renderWithProviders(<HostKeyChangedDialogHost />);
    const answer = ask();

    await user.click(screen.getByRole('button', { name: 'Trust the new key' }));

    await expect(answer).resolves.toBe(true);
    expect(useHostKeyPromptStore.getState().request).toBeNull();
  });

  it('does not connect when the user backs out', async () => {
    const { user } = renderWithProviders(<HostKeyChangedDialogHost />);
    const answer = ask();

    await user.click(screen.getByRole('button', { name: "Don't connect" }));

    await expect(answer).resolves.toBe(false);
  });

  it('treats Escape as not trusting', async () => {
    const { user } = renderWithProviders(<HostKeyChangedDialogHost />);
    const answer = ask();

    await user.keyboard('{Escape}');

    await expect(answer).resolves.toBe(false);
  });

  it('starts with the safe choice focused', () => {
    renderWithProviders(<HostKeyChangedDialogHost />);
    void ask();

    expect(screen.getByRole('button', { name: "Don't connect" })).toHaveFocus();
  });

  describe('a server never connected to before', () => {
    it('asks to check the key instead of calling it changed, and shows only the presented one', () => {
      renderWithProviders(<HostKeyChangedDialogHost />);
      void ask({ stored: null });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Check prod’s host key');
      expect(dialog).toHaveTextContent('has not connected to prod.example:2222 before');
      expect(dialog).not.toHaveTextContent('identity changed');
      expect(dialog).not.toHaveTextContent('Trusted before');
      expect(dialog).toHaveTextContent(formatHostKeyFingerprint(status.presented));
      expect(screen.queryByRole('button', { name: 'Trust the new key' })).not.toBeInTheDocument();
    });

    it('trusts the key only on the explicit button, with the safe choice focused', async () => {
      const { user } = renderWithProviders(<HostKeyChangedDialogHost />);
      const answer = ask({ stored: null });

      expect(screen.getByRole('button', { name: "Don't connect" })).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Trust and connect' }));

      await expect(answer).resolves.toBe(true);
    });
  });
});
