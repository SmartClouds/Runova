import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunovaBridge, type FakeBridge } from '../../../../test/renderer/runovaBridge';
import { SshVaultUnlockDialog } from './SshVaultUnlockDialog';

/** The servers passkey: typed, or a recovery phrase Runova makes (E107). */

const WORDS =
  'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'.split(
    ' ',
  );
const ID = 'V'.repeat(22);
let bridge: FakeBridge;
const onUnlocked = vi.fn();
const onOpenChange = vi.fn();

beforeEach(() => {
  onUnlocked.mockReset();
  onOpenChange.mockReset();
  bridge = createRunovaBridge({
    'phrase.create': { id: ID, words: WORDS },
    'ssh.setPasskey': { ok: true },
    'ssh.unlockVault': async () => true,
  });
  Object.assign(window, { runova: bridge });
});

function show(mode: 'set' | 'unlock') {
  render(
    <SshVaultUnlockDialog open mode={mode} onOpenChange={onOpenChange} onUnlocked={onUnlocked} />,
  );
}

describe('SshVaultUnlockDialog', () => {
  it('sets the passkey to a made phrase once it is checked', async () => {
    show('set');
    const set = screen.getByRole('button', { name: 'Set passkey' });
    expect(set).toBeDisabled();

    fireEvent.click(await screen.findByRole('button', { name: /I saved it/ }));
    for (let i = 0; i < 3; i++) {
      const asked = Number(
        screen.getByText(/^Which is word \d+\?$/).textContent?.match(/\d+/)?.[0],
      );
      fireEvent.click(screen.getByRole('button', { name: WORDS[asked - 1] }));
    }
    fireEvent.click(set);

    await waitFor(() =>
      expect(bridge.$fn('ssh.setPasskey')).toHaveBeenCalledWith({ phraseId: ID }),
    );
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
  });

  it('still sets a typed passkey, typed twice', async () => {
    show('set');
    fireEvent.click(screen.getByRole('button', { name: 'Type my own' }));
    fireEvent.change(screen.getByLabelText('Passkey'), { target: { value: 'my servers passkey' } });
    fireEvent.change(screen.getByLabelText('Confirm passkey'), {
      target: { value: 'my servers passkey' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set passkey' }));

    await waitFor(() =>
      expect(bridge.$fn('ssh.setPasskey')).toHaveBeenCalledWith('my servers passkey'),
    );
  });

  it('unlocks with a phrase pasted in the passkey field', async () => {
    show('unlock');

    fireEvent.paste(screen.getByLabelText('Passkey'), {
      clipboardData: { getData: () => WORDS.join(' ') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() =>
      expect(bridge.$fn('ssh.unlockVault')).toHaveBeenCalledWith(WORDS.join(' ')),
    );
  });

  it('says so when the passkey is wrong', async () => {
    bridge.$set('ssh.unlockVault', async () => false);
    show('unlock');
    fireEvent.change(screen.getByLabelText('Passkey'), { target: { value: 'not it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText('Wrong passkey.')).toBeInTheDocument();
  });
});
