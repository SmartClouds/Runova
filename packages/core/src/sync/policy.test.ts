import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENCRYPTION_POLICY,
  SYNC_COLLECTIONS,
  sealingFor,
  syncCollection,
} from './policy.js';

describe('SYNC_COLLECTIONS', () => {
  it('has unique ids that fit the server’s limit', () => {
    const ids = SYNC_COLLECTIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]{1,39}$/);
  });

  it('keeps a project’s folder on this computer', () => {
    expect(syncCollection('projects').fields.device).toContain('folderPath');
  });

  it('treats the Vault as nothing but secrets', () => {
    expect(syncCollection('vault-entries').allSecret).toBe(true);
  });
});

describe('sealingFor', () => {
  it('sends a plain collection in the clear and holds back secrets without a key', () => {
    expect(sealingFor(syncCollection('ssh-servers'), DEFAULT_ENCRYPTION_POLICY, false)).toEqual({
      mode: 'shared-only',
    });
  });

  it('does not send an all-secret collection at all without a key', () => {
    expect(sealingFor(syncCollection('vault-entries'), DEFAULT_ENCRYPTION_POLICY, false)).toEqual({
      mode: 'needs-key',
    });
  });

  it('seals only the secrets with a key and the default policy', () => {
    expect(sealingFor(syncCollection('ssh-servers'), DEFAULT_ENCRYPTION_POLICY, true)).toEqual({
      mode: 'seal-secrets',
    });
  });

  it('seals a whole server when the policy covers server connections', () => {
    expect(
      sealingFor(
        syncCollection('ssh-servers'),
        { ...DEFAULT_ENCRYPTION_POLICY, servers: true },
        true,
      ),
    ).toEqual({ mode: 'seal-all' });
  });

  it('seals environments when the policy covers them', () => {
    expect(
      sealingFor(
        syncCollection('environments'),
        { ...DEFAULT_ENCRYPTION_POLICY, environments: true },
        true,
      ),
    ).toEqual({ mode: 'seal-all' });
  });

  it('seals everything when asked, projects included', () => {
    expect(
      sealingFor(
        syncCollection('projects'),
        { ...DEFAULT_ENCRYPTION_POLICY, everything: true },
        true,
      ),
    ).toEqual({ mode: 'seal-all' });
  });

  it('always seals the Vault whole', () => {
    expect(sealingFor(syncCollection('vault-entries'), DEFAULT_ENCRYPTION_POLICY, true)).toEqual({
      mode: 'seal-all',
    });
  });
});

describe('field names', () => {
  it('names the sealed field each server store really keeps', () => {
    expect(syncCollection('ssh-servers').fields).toEqual({
      device: ['privateKeyPath', 'lastConnectedAt'],
      secret: ['secretEnvelope'],
    });
    expect(syncCollection('rdp-servers').fields.secret).toEqual(['secretEnvelope']);
    expect(syncCollection('database-connections').fields.secret).toEqual(['passwordEnvelope']);
    expect(syncCollection('health-targets').fields.secret).toEqual(['secretEnvelope']);
  });

  it('sends an environment’s files and logins only sealed', () => {
    expect(syncCollection('environments').fields.secret).toEqual(['files', 'credentials']);
  });

  it('sends an error tracking connection only whole and sealed, since it is nothing without its token', () => {
    const collection = syncCollection('error-tracking');
    expect(collection.allSecret).toBe(true);
    expect(collection.fields.device).toEqual(['checkedAt', 'problem']);
  });

  it('keeps a Vault entry’s category and an API collection’s script trust on this computer', () => {
    expect(syncCollection('vault-entries').fields.device).toEqual(['lastUsedAt', 'categoryId']);
    expect(syncCollection('api-collections').fields.device).toEqual(['scriptsTrusted']);
  });

  it('lists no secret fields in a collection that is all secret, where they would be lost', () => {
    for (const collection of SYNC_COLLECTIONS.filter((c) => c.allSecret)) {
      expect(collection.fields.secret).toEqual([]);
    }
  });
});
