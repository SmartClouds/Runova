import type { SyncScopeView } from '@shared/syncTypes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunovaBridge, type FakeBridge } from '../../../../test/renderer/runovaBridge';
import { KeyDialog } from './KeyDialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Setting and opening a sync key with a recovery phrase (E107). */

const KEY_WORDS =
  'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'.split(
    ' ',
  );
const RECOVERY_WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'.split(
    ' ',
  );
const KEY_ID = 'K'.repeat(22);
const RECOVERY_ID = 'R'.repeat(22);

const scope: SyncScopeView = {
  id: 7,
  kind: 'personal',
  teamId: null,
  name: 'Personal',
  canWrite: true,
  canManage: true,
  hasKey: false,
  unlockedHere: false,
  policy: { servers: true, environments: true, everything: false },
};

let bridge: FakeBridge;
const onClose = vi.fn();

function show(mode: 'set' | 'unlock' | 'change' | 'rotate') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeyDialog scope={scope} mode={mode} onClose={onClose} />
    </QueryClientProvider>,
  );
}

function passCheck(words: string[]) {
  for (let i = 0; i < 3; i++) {
    const asked = Number(screen.getByText(/^Which is word \d+\?$/).textContent?.match(/\d+/)?.[0]);
    fireEvent.click(screen.getByRole('button', { name: words[asked - 1] }));
  }
}

beforeEach(() => {
  onClose.mockReset();
  bridge = createRunovaBridge({
    'phrase.create': { id: KEY_ID, words: KEY_WORDS },
    'sync.setKey': { recovery: { id: RECOVERY_ID, words: RECOVERY_WORDS } },
    'sync.rotateKey': { recovery: { id: RECOVERY_ID, words: RECOVERY_WORDS } },
  });
  Object.assign(window, { runova: bridge });
});

describe('KeyDialog with recovery phrases', () => {
  it('sets the key with a made phrase once it is checked, then shows the recovery key as words', async () => {
    show('set');
    const setKey = screen.getByRole('button', { name: 'Set the key' });
    expect(setKey).toBeDisabled();

    fireEvent.click(await screen.findByRole('button', { name: /I saved it/ }));
    passCheck(KEY_WORDS);
    fireEvent.click(setKey);

    await waitFor(() =>
      expect(bridge.$fn('sync.setKey')).toHaveBeenCalledWith(
        7,
        { phraseId: KEY_ID },
        'Your own data',
      ),
    );
    expect(await screen.findByText('Save your recovery key')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show the words/ }));
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('legal');
  });

  it('after a made phrase, the recovery key only needs a tick to finish', async () => {
    show('set');
    fireEvent.click(await screen.findByRole('button', { name: /I saved it/ }));
    passCheck(KEY_WORDS);
    fireEvent.click(screen.getByRole('button', { name: 'Set the key' }));
    await screen.findByText('Save your recovery key');

    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /saved my recovery key/ }));
    fireEvent.click(done);

    expect(onClose).toHaveBeenCalled();
    expect(bridge.$fn('phrase.discard')).toHaveBeenCalledWith(RECOVERY_ID);
  });

  it('after a typed passphrase, the recovery key is checked like a phrase before Done', async () => {
    show('set');
    fireEvent.click(screen.getByRole('button', { name: 'Type my own' }));
    fireEvent.change(screen.getByLabelText('New passphrase'), {
      target: { value: 'a long and careful passphrase' },
    });
    fireEvent.change(screen.getByLabelText('Type it again'), {
      target: { value: 'a long and careful passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set the key' }));

    await waitFor(() =>
      expect(bridge.$fn('sync.setKey')).toHaveBeenCalledWith(
        7,
        { passphrase: 'a long and careful passphrase' },
        'Your own data',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: /I saved it/ }));
    passCheck(RECOVERY_WORDS);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('unlocks with the recovery key typed as words', async () => {
    show('unlock');
    fireEvent.click(screen.getByRole('button', { name: 'Use the recovery key instead' }));

    fireEvent.paste(screen.getByRole('textbox', { name: 'Word 1' }), {
      clipboardData: { getData: () => RECOVERY_WORDS.join(' ') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() =>
      expect(bridge.$fn('sync.unlock')).toHaveBeenCalledWith(7, {
        recoveryKey: RECOVERY_WORDS.join(' '),
      }),
    );
  });

  it('still takes an older recovery key in groups of characters', async () => {
    show('unlock');
    fireEvent.click(screen.getByRole('button', { name: 'Use the recovery key instead' }));
    fireEvent.click(screen.getByRole('button', { name: /older key/ }));

    fireEvent.change(screen.getByLabelText('Recovery key'), {
      target: { value: 'D2KSXB5-269477T-PCA35SR-VPAHK38-X9ES6VW-RF1Y61H-ZBRX76S-SY00000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() =>
      expect(bridge.$fn('sync.unlock')).toHaveBeenCalledWith(7, {
        recoveryKey: 'D2KSXB5-269477T-PCA35SR-VPAHK38-X9ES6VW-RF1Y61H-ZBRX76S-SY00000',
      }),
    );
  });

  it('switches to the word boxes when a phrase is pasted where the passphrase goes', async () => {
    show('unlock');

    fireEvent.paste(screen.getByLabelText('Passphrase'), {
      clipboardData: { getData: () => KEY_WORDS.join('\n') },
    });
    expect(screen.getByRole('textbox', { name: 'Word 24' })).toHaveValue('length');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() =>
      expect(bridge.$fn('sync.unlock')).toHaveBeenCalledWith(7, {
        passphrase: KEY_WORDS.join(' '),
      }),
    );
  });

  it('changes the passphrase to a made phrase', async () => {
    show('change');
    fireEvent.click(await screen.findByRole('button', { name: /I saved it/ }));
    passCheck(KEY_WORDS);
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));

    await waitFor(() =>
      expect(bridge.$fn('sync.changePassphrase')).toHaveBeenCalledWith(7, { phraseId: KEY_ID }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
