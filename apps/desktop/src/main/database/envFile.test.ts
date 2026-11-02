import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ENV_FILE_BYTES } from '@runova/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isServerEnvPath, readLocalEnvFile, serverEnvCommand } from './envFile';

/**
 * The project folder comes from a container label, which whoever started the container chose.
 * Only a file named .env is ever read, so the label cannot point Runova at anything else.
 */

describe('isServerEnvPath', () => {
  it.each(['/opt/curalink/.env', '/srv/my app/.env', '/.env'])('takes %s', (path) => {
    expect(isServerEnvPath(path)).toBe(true);
  });

  it.each([
    'opt/curalink/.env',
    '/opt/curalink/.env.production',
    '/etc/shadow',
    '/opt/../etc/.env',
    '/opt/curalink/.env\n',
    '/opt/x\u0000/.env',
    '/opt/curalink/',
  ])('refuses %j', (path) => {
    expect(isServerEnvPath(path)).toBe(false);
  });
});

describe('serverEnvCommand', () => {
  it('quotes the path and falls back to sudo without a prompt', () => {
    expect(serverEnvCommand("/srv/it's/.env")).toBe(
      "if [ -r '/srv/it'\\''s/.env' ]; then cat -- '/srv/it'\\''s/.env'; else sudo -n cat -- '/srv/it'\\''s/.env'; fi",
    );
  });

  it('refuses anything that is not a .env', () => {
    expect(() => serverEnvCommand('/etc/shadow')).toThrow(/\.env/);
  });
});

describe('readLocalEnvFile', () => {
  let folder = '';
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'runova-envfile-'));
    await writeFile(join(folder, '.env'), 'POSTGRES_PASSWORD=pw\n');
    await writeFile(join(folder, 'secrets.txt'), 'nope');
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('reads a .env in a project folder', async () => {
    expect(await readLocalEnvFile(join(folder, '.env'))).toBe('POSTGRES_PASSWORD=pw\n');
  });

  it('answers null for a missing file, another file, a relative path, or one too big', async () => {
    expect(await readLocalEnvFile(join(folder, 'missing', '.env'))).toBeNull();
    expect(await readLocalEnvFile(join(folder, 'secrets.txt'))).toBeNull();
    expect(await readLocalEnvFile('.env')).toBeNull();
    const big = await mkdtemp(join(tmpdir(), 'runova-envfile-big-'));
    try {
      await writeFile(join(big, '.env'), 'A='.padEnd(MAX_ENV_FILE_BYTES + 10, 'x'));
      expect(await readLocalEnvFile(join(big, '.env'))).toBeNull();
    } finally {
      await rm(big, { recursive: true, force: true });
    }
  });
});
