import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSaveInput } from '../../shared/databaseTypes';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * Saved database connections live in `databases.json`. A password is only ever on disk sealed
 * with the Servers vault, and only main can read it back.
 */

const userData = useTempUserData();
const FILE = 'databases.json';
const PASSWORD = 'pg-password-that-must-not-be-on-disk';

beforeAll(async () => {
  await import('./connectionStore');
}, 120_000);

let mod: typeof import('./connectionStore');
let vault: typeof import('../ssh/vault');

beforeEach(async () => {
  mod = await import('./connectionStore');
  vault = await import('../ssh/vault');
});

const store = () => new mod.DatabaseConnectionStore(userData.dataFile(FILE));

const input = (overrides: Partial<DatabaseSaveInput> = {}): DatabaseSaveInput => ({
  name: 'Shop',
  engine: 'postgres',
  target: { kind: 'direct', host: 'db.example.com', port: 5432 },
  user: 'app',
  database: 'shop',
  password: PASSWORD,
  ...overrides,
});

describe('DatabaseConnectionStore', () => {
  it('starts empty', async () => {
    expect(await store().list()).toEqual([]);
  });

  it('saves a connection with its password sealed, and lists it without the password', async () => {
    const saved = await store().save(input());
    expect(saved).toMatchObject({
      name: 'Shop',
      engine: 'postgres',
      user: 'app',
      database: 'shop',
      hasPassword: true,
      locked: false,
      readOnly: false,
      tls: false,
      srv: false,
      lastUsedAt: null,
    });
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    expect(readFileSync(userData.dataFile(FILE), 'utf-8')).not.toContain(PASSWORD);
    expect(await store().password(saved.id)).toBe(PASSWORD);
  });

  it('keeps the saved password when an update leaves it out, and drops it for an empty one', async () => {
    const one = store();
    const saved = await one.save(input());
    await one.save({ ...input({ name: 'Renamed' }), id: saved.id, password: undefined });
    expect(await one.password(saved.id)).toBe(PASSWORD);
    expect((await one.list())[0]?.name).toBe('Renamed');

    const cleared = await one.save({ ...input(), id: saved.id, password: '' });
    expect(cleared.hasPassword).toBe(false);
    expect(await one.password(saved.id)).toBeUndefined();
  });

  it('finds the connection made from a container, so the card can say it is saved', async () => {
    const one = store();
    const saved = await one.save(input(), { sourceKey: 'server:s1:app-db' });
    expect((await one.bySource('server:s1:app-db'))?.id).toBe(saved.id);
    expect(await one.bySource('server:s1:other')).toBeNull();
  });

  it('marks a connection used', async () => {
    const one = store();
    const saved = await one.save(input());
    await one.touch(saved.id, 1234);
    expect((await one.list())[0]?.lastUsedAt).toBe(1234);
  });

  it('removes a connection', async () => {
    const one = store();
    const saved = await one.save(input());
    await one.remove(saved.id);
    expect(await one.list()).toEqual([]);
    await expect(one.get(saved.id)).rejects.toThrow(/no saved connection/i);
  });

  it('turns down a connection that does not make sense', async () => {
    const one = store();
    await expect(one.save(input({ name: '  ' }))).rejects.toThrow(/name/i);
    await expect(
      one.save(input({ target: { kind: 'direct', host: '', port: 5432 } })),
    ).rejects.toThrow();
    await expect(
      one.save(input({ target: { kind: 'direct', host: 'h', port: 70_000 } })),
    ).rejects.toThrow();
    await expect(one.save(input({ engine: 'oracle' as never }))).rejects.toThrow();
  });

  it('drops entries on disk that do not fit, and refuses a file that is not JSON', async () => {
    userData.writeData(FILE, {
      connections: [{ id: 'bad' }, { ...(await validStored()), id: 'good' }],
    });
    expect((await store().list()).map((one) => one.id)).toEqual(['good']);

    const { writeFileSync } = await import('node:fs');
    writeFileSync(userData.dataFile(FILE), '{nope', 'utf-8');
    await expect(store().list()).rejects.toThrow(/not valid JSON/);
  });

  it('moves every password when the Servers passkey changes', async () => {
    const one = store();
    const saved = await one.save(input());
    const commit = await one.sealed.prepare(async (envelope) => ({
      ...envelope,
      ciphertext: `moved:${envelope.ciphertext}`,
    }));
    await commit();
    const raw = JSON.parse(readFileSync(userData.dataFile(FILE), 'utf-8')) as {
      connections: { id: string; passwordEnvelope: { ciphertext: string } }[];
    };
    expect(raw.connections.find((c) => c.id === saved.id)?.passwordEnvelope.ciphertext).toMatch(
      /^moved:/,
    );
  });

  it('hands sync every stored connection and puts one back whole, its team kept', async () => {
    const one = store();
    const saved = await one.save(input());
    const [stored] = await one.all();
    if (!stored) throw new Error('missing');
    expect(stored.passwordEnvelope).not.toBeNull();

    await one.put({ ...stored, id: 'from-sync', name: 'Other', syncTeamId: 4 });
    await one.put({ ...stored, name: 'Renamed' });

    const all = await store().all();
    expect(all.map((c) => [c.id, c.name])).toEqual([
      [saved.id, 'Renamed'],
      ['from-sync', 'Other'],
    ]);
    expect(all[1]?.syncTeamId).toBe(4);
    expect(await store().password('from-sync')).toBe(PASSWORD);
  });

  it('refuses to put a connection that does not fit', async () => {
    const one = store();
    await expect(
      one.put({ ...(await validStored()), id: 'bad', name: '' } as never),
    ).rejects.toThrow();
    expect(await one.all()).toEqual([]);
  });

  async function validStored() {
    return {
      name: 'Kept',
      engine: 'redis',
      target: { kind: 'localContainer', containerId: 'abc', containerName: 'cache', port: 6379 },
      user: null,
      database: null,
      authDatabase: null,
      tls: false,
      srv: false,
      readOnly: false,
      passwordEnvelope: await vault.encryptSecret('x'),
      sourceKey: null,
      createdAt: 1,
      lastUsedAt: null,
    };
  }
});
