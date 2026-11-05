import type { AccountStatus } from '@shared/accountTypes';
import type { SyncOverview, SyncScopeView } from '@shared/syncTypes';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { default: AccountPage } = await import('./AccountPage');
const { AccountSyncSegment } = await import('../components/layout/AccountSyncSegment');

/**
 * The Account page (E48). What matters: signed out, it explains and starts the browser sign-in;
 * signed in, it shows the account and what is in the way of syncing (a key to type, conflicts);
 * setting a key ends on the recovery key, which must be saved before the dialog closes.
 */

const SIGNED_OUT: AccountStatus = { state: 'signed-out', deviceId: 'd' };
const SIGNED_IN: AccountStatus = {
  state: 'signed-in',
  deviceId: 'd',
  sessionId: 9,
  account: { id: 42, email: 'sam@example.com', displayName: 'Sam Rivera' },
  rememberedOnDisk: true,
  needsSignIn: false,
};

function scope(overrides: Partial<SyncScopeView> = {}): SyncScopeView {
  return {
    id: 1,
    kind: 'personal',
    teamId: null,
    name: 'Personal',
    canWrite: true,
    canManage: true,
    hasKey: false,
    unlockedHere: false,
    policy: { servers: false, environments: false, everything: false },
    ...overrides,
  };
}

function overview(overrides: Partial<SyncOverview> = {}): SyncOverview {
  return {
    phase: 'idle',
    lastSyncedAt: Date.now() - 60_000,
    error: null,
    conflicts: 0,
    needsKey: [],
    scopes: [scope()],
    collections: [
      {
        id: 'projects',
        label: 'Projects',
        category: 'general',
        enabled: true,
        needsKey: false,
        shareable: true,
      },
      {
        id: 'vault-entries',
        label: 'Vault',
        category: 'vault',
        enabled: true,
        needsKey: true,
        shareable: true,
      },
    ],
    ...overrides,
  };
}

const signedInBridge = (sync: SyncOverview = overview()) => ({
  'account.status': SIGNED_IN,
  'account.sessions': [
    {
      id: 9,
      kind: 'desktop',
      deviceName: 'Sam’s PC',
      platform: 'Windows',
      appVersion: '3.4.0',
      ip: '203.0.113.5',
      createdAt: '2026-11-01T00:00:00.000Z',
      lastSeenAt: '2026-11-05T10:00:00.000Z',
      current: true,
    },
  ],
  'account.profile': { twoFactorEnabled: true },
  'sync.overview': sync,
});

describe('AccountPage', () => {
  it('explains syncing and starts the browser sign-in when signed out', async () => {
    const view = renderWithProviders(<AccountPage />, {
      route: '/account',
      bridge: { 'account.status': SIGNED_OUT, 'account.signIn': SIGNED_IN },
    });

    await view.user.click(await screen.findByRole('button', { name: /^Sign in$/ }));

    expect(
      screen.getByRole('heading', { name: 'Sign in to sync this computer' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Runova never sees your password/)).toBeInTheDocument();
    await waitFor(() => expect(view.bridge.$fn('account.signIn')).toHaveBeenCalled());
  });

  it('shows the account and its computers when signed in', async () => {
    renderWithProviders(<AccountPage />, { route: '/account', bridge: signedInBridge() });

    expect(await screen.findByRole('heading', { name: 'Sam Rivera' })).toBeInTheDocument();
    expect(screen.getByText('sam@example.com')).toBeInTheDocument();
    expect(await screen.findByText('Sam’s PC')).toBeInTheDocument();
    expect(
      screen.getByText(/Passwords and keys stay on this computer until you set an encryption key/),
    ).toBeInTheDocument();
  });

  it('asks for the key on a computer where the scope is locked', async () => {
    renderWithProviders(<AccountPage />, {
      route: '/account?tab=sync',
      bridge: signedInBridge(
        overview({ scopes: [scope({ hasKey: true, unlockedHere: false })], needsKey: [1] }),
      ),
    });

    expect(await screen.findByText('Locked on this computer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unlock here/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Sealed items from your other computers are waiting/),
    ).toBeInTheDocument();
  });

  it('sets a key, then holds the dialog open until the recovery key is saved', async () => {
    const view = renderWithProviders(<AccountPage />, {
      route: '/account?tab=sync',
      bridge: {
        ...signedInBridge(),
        'sync.setKey': {
          recoveryKey: 'ABCDEFG-HJKMNPQ-RSTVWXY-Z012345-6789ABC-DEFGHJK-MNPQRST-VWXYZ01',
        },
      },
    });

    await view.user.click(await screen.findByRole('button', { name: /Set a key/ }));
    await view.user.type(screen.getByLabelText('New passphrase'), 'correct horse battery staple');
    await view.user.type(screen.getByLabelText('Type it again'), 'correct horse battery staple');
    await view.user.click(screen.getByRole('button', { name: 'Set the key' }));

    expect(await screen.findByText(/ABCDEFG-HJKMNPQ/)).toBeInTheDocument();
    expect(view.bridge.$fn('sync.setKey')).toHaveBeenCalledWith(1, 'correct horse battery staple');
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await view.user.click(screen.getByLabelText(/I saved my recovery key/));
    expect(done).toBeEnabled();
  });

  it('refuses two passphrases that differ before anything is sent', async () => {
    const setKey = vi.fn();
    const view = renderWithProviders(<AccountPage />, {
      route: '/account?tab=sync',
      bridge: { ...signedInBridge(), 'sync.setKey': setKey },
    });

    await view.user.click(await screen.findByRole('button', { name: /Set a key/ }));
    await view.user.type(screen.getByLabelText('New passphrase'), 'correct horse battery staple');
    await view.user.type(screen.getByLabelText('Type it again'), 'correct horse battery stable');
    await view.user.click(screen.getByRole('button', { name: 'Set the key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not the same');
    expect(setKey).not.toHaveBeenCalled();
  });
});

describe('AccountSyncSegment', () => {
  it('stays out of the status bar while signed out', async () => {
    const view = renderWithProviders(<AccountSyncSegment />, {
      bridge: { 'account.status': SIGNED_OUT },
    });

    await waitFor(() => expect(view.bridge.$fn('account.status')).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says how many items wait for review', async () => {
    renderWithProviders(<AccountSyncSegment />, {
      bridge: signedInBridge(overview({ conflicts: 2 })),
    });

    expect(await screen.findByText('2 to review')).toBeInTheDocument();
  });

  it('says Synced when nothing is in the way', async () => {
    renderWithProviders(<AccountSyncSegment />, { bridge: signedInBridge() });

    expect(await screen.findByText('Synced')).toBeInTheDocument();
  });
});
