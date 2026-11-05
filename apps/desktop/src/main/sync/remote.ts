import type { EncryptionPolicy } from '@runova/core';
import type { AccountClient } from '../account/client';
import type { KeyEnvelope } from '../account/keyring';
import type { WireRecord } from './syncDb';
import type { ChangesPage, PushRecord, PushResult, SyncApi, SyncScopeInfo } from './types';

/** The website API's sync routes (docs/website/api-contract.md, Sync), over the signed-in client. */

export interface ScopeUsage {
  records: number;
  bytes: number;
  quotaBytes: number;
  collections: Record<string, number>;
}

export function createRemoteSyncApi(client: Pick<AccountClient, 'request'>) {
  const api: SyncApi & {
    usage: (scopeId: number) => Promise<ScopeUsage>;
    setPolicy: (scopeId: number, policy: EncryptionPolicy) => Promise<SyncScopeInfo>;
    key: (scopeId: number) => Promise<{ version: number; envelope: KeyEnvelope } | null>;
    putKey: (scopeId: number, version: number, envelope: KeyEnvelope) => Promise<void>;
    resetKey: (scopeId: number, stepUp: { password?: string; code?: string }) => Promise<void>;
    wipe: (scopeId: number, stepUp: { password?: string; code?: string }) => Promise<void>;
  } = {
    async scopes() {
      return (await client.request<{ items: SyncScopeInfo[] }>('GET', '/sync-scopes')).items;
    },
    changes(scopeId, since, limit): Promise<ChangesPage> {
      return client
        .request<{ records: WireRecord[]; next: number; more: boolean }>(
          'GET',
          `/sync-scopes/${scopeId}/changes?since=${since}&limit=${limit}`,
        )
        .then((page) => ({ records: page.records, next: page.next, more: page.more }));
    },
    push(scopeId, records: PushRecord[]): Promise<PushResult> {
      return client.request<PushResult>('POST', `/sync-scopes/${scopeId}/records`, { records });
    },
    usage: (scopeId) => client.request<ScopeUsage>('GET', `/sync-scopes/${scopeId}/usage`),
    setPolicy: (scopeId, policy) =>
      client.request<SyncScopeInfo>('PATCH', `/sync-scopes/${scopeId}`, { policy }),
    async key(scopeId) {
      try {
        return await client.request<{ version: number; envelope: KeyEnvelope }>(
          'GET',
          `/sync-scopes/${scopeId}/keys/current`,
        );
      } catch (error) {
        if ((error as { problem?: { status?: number } }).problem?.status === 404) return null;
        throw error;
      }
    },
    putKey: (scopeId, version, envelope) =>
      client.request<void>('PUT', `/sync-scopes/${scopeId}/keys/current`, { version, envelope }),
    resetKey: (scopeId, stepUp) =>
      client.request<void>('DELETE', `/sync-scopes/${scopeId}/keys/current`, {
        password: stepUp.password ?? null,
        code: stepUp.code ?? null,
      }),
    wipe: (scopeId, stepUp) =>
      client.request<void>('DELETE', `/sync-scopes/${scopeId}/records`, {
        password: stepUp.password ?? null,
        code: stepUp.code ?? null,
      }),
  };
  return api;
}

export type RemoteSyncApi = ReturnType<typeof createRemoteSyncApi>;
