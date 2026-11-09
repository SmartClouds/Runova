import { ipcRenderer } from 'electron';
import type {
  AccountActivityPage,
  AccountProfile,
  AccountSession,
  AccountStatus,
  EncryptionItemName,
  EncryptionStatus,
  StepUp,
} from '../shared/accountTypes';
import { IPC } from '../shared/ipcChannels';
import type {
  MyInvitationView,
  ShareableGroup,
  ShareTarget,
  SyncConflictView,
  SyncOverview,
  SyncPolicy,
  SyncUsageView,
  TeamInvitationView,
  TeamMemberView,
  TeamRole,
  TeamView,
} from '../shared/syncTypes';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** The Runova account on this computer (E48). Signing in opens the browser. */
export function createAccount() {
  return {
    status: (): Promise<AccountStatus> => ipcRenderer.invoke(IPC.account.status),
    encryption: (): Promise<EncryptionStatus> => ipcRenderer.invoke(IPC.account.encryption),
    setEncryption: (item: EncryptionItemName, enabled: boolean): Promise<EncryptionStatus> =>
      ipcRenderer.invoke(IPC.account.setEncryption, { item, enabled }),
    signIn: (): Promise<AccountStatus> => ipcRenderer.invoke(IPC.account.signIn),
    cancelSignIn: (): Promise<void> => ipcRenderer.invoke(IPC.account.cancelSignIn),
    signOut: (): Promise<void> => ipcRenderer.invoke(IPC.account.signOut),
    profile: (): Promise<AccountProfile> => ipcRenderer.invoke(IPC.account.profile),
    sessions: (): Promise<AccountSession[]> => ipcRenderer.invoke(IPC.account.sessions),
    endSession: (id: number): Promise<void> => ipcRenderer.invoke(IPC.account.endSession, { id }),
    endOtherSessions: (stepUp: StepUp): Promise<void> =>
      ipcRenderer.invoke(IPC.account.endOtherSessions, stepUp),
    activities: (page = 1): Promise<AccountActivityPage> =>
      ipcRenderer.invoke(IPC.account.activities, { page }),
    openWebsite: (path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.account.openWebsite, { path }),
    onChanged: (callback: (status: AccountStatus) => void): (() => void) =>
      subscribe(IPC.account.onChanged, callback),
  };
}

/** Cloud sync: status, keys, the policy and conflicts. */
export function createSync() {
  return {
    overview: (): Promise<SyncOverview> => ipcRenderer.invoke(IPC.sync.overview),
    syncNow: (): Promise<SyncOverview> => ipcRenderer.invoke(IPC.sync.syncNow),
    setCollectionEnabled: (collection: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.sync.setCollectionEnabled, { collection, enabled }),
    setPolicy: (scopeId: number, policy: SyncPolicy): Promise<void> =>
      ipcRenderer.invoke(IPC.sync.setPolicy, { scopeId, policy }),
    usage: (scopeId: number): Promise<SyncUsageView> =>
      ipcRenderer.invoke(IPC.sync.usage, { scopeId }),
    setKey: (scopeId: number, passphrase: string): Promise<{ recoveryKey: string }> =>
      ipcRenderer.invoke(IPC.sync.setKey, { scopeId, passphrase }),
    unlock: (
      scopeId: number,
      secret: { passphrase: string } | { recoveryKey: string },
    ): Promise<void> => ipcRenderer.invoke(IPC.sync.unlock, { scopeId, ...secret }),
    changePassphrase: (scopeId: number, passphrase: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sync.changePassphrase, { scopeId, passphrase }),
    rotateKey: (scopeId: number, passphrase: string): Promise<{ recoveryKey: string }> =>
      ipcRenderer.invoke(IPC.sync.rotateKey, { scopeId, passphrase }),
    resetKey: (scopeId: number, stepUp: StepUp): Promise<void> =>
      ipcRenderer.invoke(IPC.sync.resetKey, { scopeId, ...stepUp }),
    wipeCloud: (scopeId: number, stepUp: StepUp): Promise<void> =>
      ipcRenderer.invoke(IPC.sync.wipeCloud, { scopeId, ...stepUp }),
    conflicts: (): Promise<SyncConflictView[]> => ipcRenderer.invoke(IPC.sync.conflicts),
    resolve: (
      target: { scopeId: number; collection: string; itemId: string },
      choice: 'mine' | 'theirs' | 'both',
    ): Promise<void> => ipcRenderer.invoke(IPC.sync.resolve, { ...target, choice }),
    share: (target: ShareTarget): Promise<void> => ipcRenderer.invoke(IPC.sync.share, target),
    shareable: (): Promise<ShareableGroup[]> => ipcRenderer.invoke(IPC.sync.shareable),
    onChanged: (callback: (overview: SyncOverview) => void): (() => void) =>
      subscribe(IPC.sync.onChanged, callback),
  };
}

/** Teams of Runova accounts. */
export function createTeams() {
  return {
    list: (): Promise<TeamView[]> => ipcRenderer.invoke(IPC.teams.list),
    create: (name: string): Promise<TeamView> => ipcRenderer.invoke(IPC.teams.create, { name }),
    rename: (teamId: number, name: string): Promise<TeamView> =>
      ipcRenderer.invoke(IPC.teams.rename, { teamId, name }),
    remove: (teamId: number, stepUp: StepUp): Promise<void> =>
      ipcRenderer.invoke(IPC.teams.remove, { teamId, ...stepUp }),
    members: (teamId: number): Promise<TeamMemberView[]> =>
      ipcRenderer.invoke(IPC.teams.members, { teamId }),
    changeRole: (
      teamId: number,
      userId: number,
      role: TeamRole,
      stepUp: StepUp,
    ): Promise<TeamMemberView> =>
      ipcRenderer.invoke(IPC.teams.changeRole, { teamId, userId, role, ...stepUp }),
    removeMember: (teamId: number, userId: number, stepUp: StepUp = {}): Promise<void> =>
      ipcRenderer.invoke(IPC.teams.removeMember, { teamId, userId, ...stepUp }),
    invitations: (teamId: number): Promise<TeamInvitationView[]> =>
      ipcRenderer.invoke(IPC.teams.invitations, { teamId }),
    invite: (teamId: number, email: string, role: TeamRole): Promise<TeamInvitationView> =>
      ipcRenderer.invoke(IPC.teams.invite, { teamId, email, role }),
    withdraw: (teamId: number, invitationId: number): Promise<void> =>
      ipcRenderer.invoke(IPC.teams.withdraw, { teamId, invitationId }),
    activities: (teamId: number, page = 1): Promise<AccountActivityPage> =>
      ipcRenderer.invoke(IPC.teams.activities, { teamId, page }),
    myInvitations: (): Promise<MyInvitationView[]> => ipcRenderer.invoke(IPC.teams.myInvitations),
    accept: (id: number): Promise<TeamView> => ipcRenderer.invoke(IPC.teams.accept, { id }),
    decline: (id: number): Promise<void> => ipcRenderer.invoke(IPC.teams.decline, { id }),
  };
}
