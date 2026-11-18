// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import {
  createVaultApiMock,
  expectNoNativeTitles,
  installDomShims,
  installVaultApi,
  MOCK_PHRASE_ID,
  MOCK_PHRASE_WORDS,
  renderWithVaultProviders,
  type VaultApiMock,
} from './testing/mockVaultApi';
import { VaultLockedScreen } from './VaultLockedScreen';
import { VaultSetupScreen } from './VaultSetupScreen';

installDomShims();

const STRONG = 'violet lantern orbit 42';
let mock: VaultApiMock;

beforeEach(() => {
  mock = createVaultApiMock({ state: 'uninitialized' });
  installVaultApi(mock);
  useVaultStore.getState().setLastLockReason(null);
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
  vi.useRealTimers();
});

describe('VaultSetupScreen', () => {
  const password = () => screen.getByLabelText('Master password');
  const confirm = () => screen.getByLabelText('Type it again');
  const create = () => screen.getByRole('button', { name: 'Create vault' });

  const typeOwn = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Type my own password' }));

  it('only enables Create once the password is strong, confirmed and the warning is accepted', () => {
    renderWithVaultProviders(<VaultSetupScreen />);
    typeOwn();
    expect(create().hasAttribute('disabled')).toBe(true);

    fireEvent.change(password(), { target: { value: 'short' } });
    expect(screen.getByText('Use at least 10 characters.')).toBeTruthy();

    fireEvent.change(password(), { target: { value: STRONG } });
    fireEvent.change(confirm(), { target: { value: `${STRONG}!` } });
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    expect(create().hasAttribute('disabled')).toBe(true);

    fireEvent.change(confirm(), { target: { value: STRONG } });
    expect(create().hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /can't recover/i }));
    expect(create().hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('meter', { name: 'Password strength' })).toBeTruthy();
  });

  it('creates the vault and shows what went wrong when it fails', async () => {
    mock.api.create.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'vault:create': Error: [vault:exists] A vault already exists.",
      ),
    );
    renderWithVaultProviders(<VaultSetupScreen />);
    typeOwn();
    fireEvent.change(password(), { target: { value: STRONG } });
    fireEvent.change(confirm(), { target: { value: STRONG } });
    fireEvent.click(screen.getByRole('checkbox', { name: /can't recover/i }));
    fireEvent.click(create());

    expect((await screen.findByRole('alert')).textContent).toContain('A vault already exists.');
    expect(mock.api.create).toHaveBeenCalledWith(STRONG);

    fireEvent.click(create());
    await waitFor(() => expect(mock.api.create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('VaultSetupScreen with a recovery phrase (E107)', () => {
  it('offers a made phrase first, and creates the vault with it once it is checked', async () => {
    renderWithVaultProviders(<VaultSetupScreen />);
    const create = screen.getByRole('button', { name: 'Create vault' });

    fireEvent.click(await screen.findByRole('button', { name: /I saved it/ }));
    for (let i = 0; i < 3; i++) {
      const asked = Number(
        screen.getByText(/^Which is word \d+\?$/).textContent?.match(/\d+/)?.[0],
      );
      fireEvent.click(screen.getByRole('button', { name: MOCK_PHRASE_WORDS[asked - 1] }));
    }
    expect(create.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /can't recover/i }));
    fireEvent.click(create);

    await waitFor(() => expect(mock.api.create).toHaveBeenCalledWith({ phraseId: MOCK_PHRASE_ID }));
  });
});

describe('VaultLockedScreen', () => {
  const input = () => screen.getByLabelText('Master password');
  const unlockButton = () => screen.getByRole('button', { name: /unlock/i });

  it('focuses the password field and unlocks on Enter', async () => {
    renderWithVaultProviders(<VaultLockedScreen status={{ ...mock.status, state: 'locked' }} />);
    expect(document.activeElement).toBe(input());
    fireEvent.change(input(), { target: { value: STRONG } });
    fireEvent.submit(input().closest('form') as HTMLFormElement);
    await waitFor(() => expect(mock.api.unlock).toHaveBeenCalledWith(STRONG));
  });

  it('says the password was wrong, clears the field and keeps focus there', async () => {
    mock.api.unlock.mockResolvedValueOnce({
      ok: false,
      reason: 'wrong-password',
      retryAfterMs: 0,
    } as never);
    renderWithVaultProviders(<VaultLockedScreen status={{ ...mock.status, state: 'locked' }} />);
    fireEvent.change(input(), { target: { value: 'nope nope nope' } });
    fireEvent.click(unlockButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/doesn't match/i);
    expect((input() as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(input());
  });

  it('counts down while unlocking is throttled and then lets you try again', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    mock.api.unlock.mockResolvedValueOnce({
      ok: false,
      reason: 'wrong-password',
      retryAfterMs: 2000,
    } as never);
    renderWithVaultProviders(<VaultLockedScreen status={{ ...mock.status, state: 'locked' }} />);
    fireEvent.change(input(), { target: { value: 'nope nope nope' } });
    await act(async () => {
      fireEvent.click(unlockButton());
    });
    expect(screen.getByText(/try again in 2s/i)).toBeTruthy();
    expect(unlockButton().hasAttribute('disabled')).toBe(true);

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText(/try again in 1s/i)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText(/try again in/i)).toBeNull();
    fireEvent.change(input(), { target: { value: STRONG } });
    expect(unlockButton().hasAttribute('disabled')).toBe(false);
  });

  it('unlocks with a recovery phrase in the word boxes', async () => {
    renderWithVaultProviders(<VaultLockedScreen status={{ ...mock.status, state: 'locked' }} />);

    fireEvent.click(screen.getByRole('button', { name: /recovery phrase/ }));
    fireEvent.paste(screen.getByRole('textbox', { name: 'Word 1' }), {
      clipboardData: { getData: () => MOCK_PHRASE_WORDS.join(' ') },
    });
    fireEvent.click(unlockButton());

    await waitFor(() => expect(mock.api.unlock).toHaveBeenCalledWith(MOCK_PHRASE_WORDS.join(' ')));
  });

  it('opens the word boxes when a phrase is pasted in the password field', () => {
    renderWithVaultProviders(<VaultLockedScreen status={{ ...mock.status, state: 'locked' }} />);

    fireEvent.paste(input(), { clipboardData: { getData: () => MOCK_PHRASE_WORDS.join('\n') } });

    expect(screen.getByRole('textbox', { name: 'Word 24' })).toHaveProperty('value', 'length');
  });

  it('starts throttled when main says so', () => {
    renderWithVaultProviders(
      <VaultLockedScreen status={{ ...mock.status, state: 'locked', retryAfterMs: 5000 }} />,
    );
    expect(screen.getByText(/try again in 5s/i)).toBeTruthy();
  });

  it('explains why it locked', () => {
    useVaultStore.getState().setLastLockReason('idle');
    renderWithVaultProviders(
      <VaultLockedScreen status={{ ...mock.status, state: 'locked', autoLockMinutes: 15 }} />,
    );
    expect(screen.getByText('Locked after 15 minutes without activity.')).toBeTruthy();
  });

  it('offers a reset when the vault file is damaged', async () => {
    mock.api.unlock.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'vault:unlock': Error: [vault:corrupt] The vault file is damaged and cannot be opened.",
      ),
    );
    renderWithVaultProviders(<VaultLockedScreen status={{ ...mock.status, state: 'locked' }} />);
    fireEvent.change(input(), { target: { value: STRONG } });
    fireEvent.click(unlockButton());
    expect((await screen.findByRole('alert')).textContent).toContain('damaged');
    fireEvent.click(screen.getByRole('button', { name: 'Forgot your master password?' }));
    expect(await screen.findByRole('dialog', { name: 'Reset the vault?' })).toBeTruthy();
  });
});
