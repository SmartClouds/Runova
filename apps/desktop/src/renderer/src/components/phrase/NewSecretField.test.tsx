import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunovaBridge, type FakeBridge } from '../../../../test/renderer/runovaBridge';
import { NewSecretField, type SecretMode } from './NewSecretField';

const WORDS =
  'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'.split(
    ' ',
  );
let made = 0;
let bridge: FakeBridge;
const onPhraseReady = vi.fn();

function Harness({ initial = 'phrase' as SecretMode }) {
  const [mode, setMode] = useState<SecretMode>(initial);
  return (
    <NewSecretField
      purpose="vault"
      label="Vault"
      mode={mode}
      onModeChange={setMode}
      onPhraseReady={onPhraseReady}
      typed={<input aria-label="Your own password" />}
    />
  );
}

/** Answers the three checks by reading which word each one asks for. */
function passCheck() {
  for (let i = 0; i < 3; i++) {
    const asked = Number(screen.getByText(/^Which is word \d+\?$/).textContent?.match(/\d+/)?.[0]);
    fireEvent.click(screen.getByRole('button', { name: WORDS[asked - 1] }));
  }
}

beforeEach(() => {
  made = 0;
  onPhraseReady.mockReset();
  bridge = createRunovaBridge({
    'phrase.create': () => {
      made += 1;
      return Promise.resolve({ id: `${'A'.repeat(21)}${made}`, words: WORDS });
    },
  });
  Object.assign(window, { runova: bridge });
});

describe('NewSecretField', () => {
  it('makes a phrase for its purpose and only hands it over after the check', async () => {
    render(<Harness />);

    await waitFor(() => expect(bridge.$fn('phrase.create')).toHaveBeenCalledWith('vault', 'Vault'));
    expect(screen.getByRole('button', { name: 'Create a phrase for me' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(await screen.findByRole('button', { name: /I saved it/ }));
    expect(onPhraseReady).not.toHaveBeenCalledWith(
      expect.objectContaining({ phraseId: expect.any(String) }),
    );

    passCheck();

    expect(onPhraseReady).toHaveBeenLastCalledWith({ phraseId: `${'A'.repeat(21)}1` });
    expect(screen.getByText(/Your phrase is checked/)).toBeInTheDocument();
  });

  it('shows the typed fields instead when asked, and lets the phrase go', async () => {
    render(<Harness />);
    await screen.findByRole('button', { name: /I saved it/ });

    fireEvent.click(screen.getByRole('button', { name: 'Type my own' }));

    expect(screen.getByRole('textbox', { name: 'Your own password' })).toBeInTheDocument();
    expect(onPhraseReady).toHaveBeenLastCalledWith(null);
    expect(bridge.$fn('phrase.discard')).toHaveBeenCalledWith(`${'A'.repeat(21)}1`);
  });

  it('makes a different phrase on request and forgets the old one', async () => {
    render(<Harness />);
    await screen.findByRole('button', { name: /I saved it/ });

    fireEvent.click(screen.getByRole('button', { name: /Make a different phrase/ }));

    await waitFor(() => expect(bridge.$fn('phrase.create')).toHaveBeenCalledTimes(2));
    expect(bridge.$fn('phrase.discard')).toHaveBeenCalledWith(`${'A'.repeat(21)}1`);
  });

  it('lets the phrase go when it leaves the screen', async () => {
    const { unmount } = render(<Harness />);
    await screen.findByRole('button', { name: /I saved it/ });

    unmount();

    expect(bridge.$fn('phrase.discard')).toHaveBeenCalledWith(`${'A'.repeat(21)}1`);
  });

  it('says what went wrong when no phrase could be made', async () => {
    bridge.$set('phrase.create', () => Promise.reject(new Error('That request is not valid.')));
    render(<Harness />);

    expect(await screen.findByRole('alert')).toHaveTextContent('That request is not valid.');
  });

  it('starts on the typed fields without making a phrase', () => {
    render(<Harness initial="typed" />);

    expect(screen.getByRole('textbox', { name: 'Your own password' })).toBeInTheDocument();
    expect(made).toBe(0);
  });
});
