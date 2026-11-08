import { describe, expect, it, vi } from 'vitest';
import { endRemoteOnSignOut } from './signOut';

describe('endRemoteOnSignOut', () => {
  it('stops hosting and ends the outgoing session', () => {
    const manager = { stopHost: vi.fn(), closeSessionAndDisconnect: vi.fn() };

    endRemoteOnSignOut(manager);

    expect(manager.stopHost).toHaveBeenCalledOnce();
    expect(manager.closeSessionAndDisconnect).toHaveBeenCalledOnce();
  });
});
