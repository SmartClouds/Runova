import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import { createDeletionLog } from './deletionLog';

const entry = (label: string) => ({
  at: 1_700_000_000_000,
  providerId: 'nuget' as const,
  label,
  paths: [`/cache/${label}`],
  bytes: 1234,
});

describe('createDeletionLog', () => {
  it('writes one line of JSON for each thing removed', async () => {
    const file = join(tempDir(), 'systemCleanup.log');
    const log = createDeletionLog(file);
    await log.append(entry('acornima 1.0.0'));
    await log.append(entry('sass 2.0.0'));
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual(entry('acornima 1.0.0'));
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ label: 'sass 2.0.0', bytes: 1234 });
  });

  it('makes the folder it lives in if it is not there yet', async () => {
    const file = join(tempDir(), 'deep', 'er', 'systemCleanup.log');
    await createDeletionLog(file).append(entry('a'));
    expect(existsSync(file)).toBe(true);
  });

  it('starts a new file when the old one gets large, keeping the last one beside it', async () => {
    const file = join(tempDir(), 'systemCleanup.log');
    const log = createDeletionLog(file, { maxBytes: 300 });
    for (let index = 0; index < 12; index += 1) await log.append(entry(`item-${index}`));
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThan(600);
    const everything = readFileSync(`${file}.1`, 'utf-8') + readFileSync(file, 'utf-8');
    expect(everything).toContain('item-11');
  });
});
