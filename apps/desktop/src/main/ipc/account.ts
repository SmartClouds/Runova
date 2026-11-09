import { ipcMain } from 'electron';
import { z } from 'zod';
import type { EncryptionItemName, EncryptionStatus } from '../../shared/accountTypes';
import { IPC } from '../../shared/ipcChannels';
import type { AccountRuntime } from '../account/runtime';
import { refreshNotificationForwarding } from '../notifications/forward';

/**
 * The account, sync and teams channels (E48). Every payload is checked here before the runtime
 * sees it. Passphrases and step-up passwords pass through to the main process only; nothing that
 * opens a key ever goes back to the renderer.
 */

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const stepUp = z.strictObject({
  password: z.string().max(1024).optional(),
  code: z.string().max(32).optional(),
});
const scope = z.strictObject({ scopeId: id });
const passphrase = z.string().min(1).max(1024);
const role = z.enum(['owner', 'admin', 'member', 'viewer']);
const collection = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const itemId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join('.');
  throw new Error(`That request is not valid${field ? ` (${field})` : ''}.`);
}

export function registerAccountHandlers(runtime: () => AccountRuntime): void {
  const handle = (channel: string, schema: z.ZodType | null, run: (input: never) => unknown) =>
    ipcMain.handle(channel, (_event, payload: unknown) =>
      run((schema ? parse(schema, payload) : undefined) as never),
    );

  handle(IPC.account.status, null, () => runtime().status());
  handle(IPC.account.encryption, null, () =>
    runtime().api<EncryptionStatus>('GET', '/accounts/me/encryption'),
  );
  handle(
    IPC.account.setEncryption,
    z.strictObject({ item: z.enum(['notifications', 'sync']), enabled: z.boolean() }),
    async (input: { item: EncryptionItemName; enabled: boolean }) => {
      const status = await runtime().api<EncryptionStatus>(
        'PUT',
        `/accounts/me/encryption/${input.item}`,
        { enabled: input.enabled },
      );
      if (input.item === 'notifications') refreshNotificationForwarding();
      // The policy lives on the server, so the next sync is what picks the new one up.
      else runtime().trigger(0);
      return status;
    },
  );
  handle(IPC.account.signIn, null, () => runtime().signIn());
  handle(IPC.account.cancelSignIn, null, () => runtime().cancelSignIn());
  handle(IPC.account.signOut, null, () => runtime().signOut());
  handle(IPC.account.profile, null, () => runtime().profile());
  handle(IPC.account.sessions, null, () => runtime().sessions());
  handle(IPC.account.endSession, z.strictObject({ id }), (input: { id: number }) =>
    runtime().endSession(input.id),
  );
  handle(IPC.account.endOtherSessions, stepUp, (input: z.infer<typeof stepUp>) =>
    runtime().endOtherSessions(input),
  );
  handle(
    IPC.account.activities,
    z.strictObject({ page: z.number().int().min(1).max(10_000) }),
    (input: { page: number }) => runtime().activities(input.page),
  );
  handle(
    IPC.account.openWebsite,
    z.strictObject({ path: z.string().max(200) }),
    (input: { path: string }) => runtime().openWebsite(input.path),
  );

  handle(IPC.sync.overview, null, () => runtime().overview());
  handle(IPC.sync.syncNow, null, () => runtime().syncNow());
  handle(
    IPC.sync.setCollectionEnabled,
    z.strictObject({ collection, enabled: z.boolean() }),
    (input: { collection: string; enabled: boolean }) =>
      runtime().setCollectionEnabled(input.collection, input.enabled),
  );
  handle(
    IPC.sync.setPolicy,
    z.strictObject({
      scopeId: id,
      policy: z.strictObject({
        servers: z.boolean(),
        environments: z.boolean(),
        everything: z.boolean(),
      }),
    }),
    (input: {
      scopeId: number;
      policy: { servers: boolean; environments: boolean; everything: boolean };
    }) => runtime().setPolicy(input.scopeId, input.policy),
  );
  handle(IPC.sync.usage, scope, (input: { scopeId: number }) => runtime().usage(input.scopeId));
  handle(
    IPC.sync.setKey,
    z.strictObject({ scopeId: id, passphrase }),
    (input: { scopeId: number; passphrase: string }) =>
      runtime().setKey(input.scopeId, input.passphrase),
  );
  handle(
    IPC.sync.unlock,
    z
      .strictObject({
        scopeId: id,
        passphrase: passphrase.optional(),
        recoveryKey: z.string().max(200).optional(),
      })
      .refine(
        (v) => !!v.passphrase !== !!v.recoveryKey,
        'Send the passphrase or the recovery key.',
      ),
    (input: { scopeId: number; passphrase?: string; recoveryKey?: string }) =>
      runtime().unlock(input.scopeId, {
        ...(input.passphrase ? { passphrase: input.passphrase } : {}),
        ...(input.recoveryKey ? { recoveryKey: input.recoveryKey } : {}),
      }),
  );
  handle(
    IPC.sync.changePassphrase,
    z.strictObject({ scopeId: id, passphrase }),
    (input: { scopeId: number; passphrase: string }) =>
      runtime().changePassphrase(input.scopeId, input.passphrase),
  );
  handle(
    IPC.sync.rotateKey,
    z.strictObject({ scopeId: id, passphrase }),
    (input: { scopeId: number; passphrase: string }) =>
      runtime().rotateKey(input.scopeId, input.passphrase),
  );
  handle(
    IPC.sync.resetKey,
    stepUp.extend({ scopeId: id }),
    (input: { scopeId: number; password?: string; code?: string }) =>
      runtime().resetKey(input.scopeId, input),
  );
  handle(
    IPC.sync.wipeCloud,
    stepUp.extend({ scopeId: id }),
    (input: { scopeId: number; password?: string; code?: string }) =>
      runtime().wipeCloud(input.scopeId, input),
  );
  handle(IPC.sync.conflicts, null, () => runtime().conflicts());
  handle(IPC.sync.shareable, null, () => runtime().shareable());
  handle(
    IPC.sync.resolve,
    z.strictObject({ scopeId: id, collection, itemId, choice: z.enum(['mine', 'theirs', 'both']) }),
    (input: {
      scopeId: number;
      collection: string;
      itemId: string;
      choice: 'mine' | 'theirs' | 'both';
    }) => runtime().resolve(input, input.choice),
  );
  handle(
    IPC.sync.share,
    z.strictObject({ collection, itemId: z.string().min(1).max(64), teamId: id.nullable() }),
    (input: { collection: string; itemId: string; teamId: number | null }) =>
      runtime().share(input),
  );

  const teams = () => runtime().teams;
  const team = z.strictObject({ teamId: id });
  handle(IPC.teams.list, null, () => teams().list());
  handle(
    IPC.teams.create,
    z.strictObject({ name: z.string().min(1).max(80) }),
    (input: { name: string }) => teams().create(input.name),
  );
  handle(
    IPC.teams.rename,
    z.strictObject({ teamId: id, name: z.string().min(1).max(80) }),
    (input: { teamId: number; name: string }) => teams().rename(input.teamId, input.name),
  );
  handle(
    IPC.teams.remove,
    stepUp.extend({ teamId: id }),
    (input: { teamId: number; password?: string; code?: string }) =>
      teams().remove(input.teamId, input),
  );
  handle(IPC.teams.members, team, (input: { teamId: number }) => teams().members(input.teamId));
  handle(
    IPC.teams.changeRole,
    stepUp.extend({ teamId: id, userId: id, role }),
    (input: { teamId: number; userId: number; role: string; password?: string; code?: string }) =>
      teams().changeRole(input.teamId, input.userId, input.role, {
        ...(input.password ? { password: input.password } : {}),
        ...(input.code ? { code: input.code } : {}),
      }),
  );
  handle(
    IPC.teams.removeMember,
    stepUp.extend({ teamId: id, userId: id }),
    (input: { teamId: number; userId: number; password?: string; code?: string }) =>
      teams().removeMember(input.teamId, input.userId, input),
  );
  handle(IPC.teams.invitations, team, (input: { teamId: number }) =>
    teams().invitations(input.teamId),
  );
  handle(
    IPC.teams.invite,
    z.strictObject({ teamId: id, email: z.string().email().max(320), role }),
    (input: { teamId: number; email: string; role: string }) =>
      teams().invite(input.teamId, input.email, input.role),
  );
  handle(
    IPC.teams.withdraw,
    z.strictObject({ teamId: id, invitationId: id }),
    (input: { teamId: number; invitationId: number }) =>
      teams().withdraw(input.teamId, input.invitationId),
  );
  handle(
    IPC.teams.activities,
    z.strictObject({ teamId: id, page: z.number().int().min(1).max(10_000) }),
    (input: { teamId: number; page: number }) => teams().activities(input.teamId, input.page),
  );
  handle(IPC.teams.myInvitations, null, () => teams().myInvitations());
  handle(IPC.teams.accept, z.strictObject({ id }), (input: { id: number }) =>
    teams().accept(input.id),
  );
  handle(IPC.teams.decline, z.strictObject({ id }), (input: { id: number }) =>
    teams().decline(input.id),
  );
}
