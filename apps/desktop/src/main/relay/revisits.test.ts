import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderItemFile } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageScanResult } from '../../shared/apiTypes';
import { workaroundRevisits } from './revisits';
import { type RelayFolder, relayFolder } from './taskFiles';

let root: string;
let folder: RelayFolder;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-revisits-'));
  folder = relayFolder(root, 'docs');
  mkdirSync(join(folder.tasksDir, 'workarounds'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function workaround(id: string, fields: Record<string, string>, status = 'open'): void {
  writeFileSync(
    join(folder.tasksDir, 'workarounds', `${id}-x.md`),
    renderItemFile({ kind: 'workaround', id, title: `Workaround ${id}`, status, ...fields }),
  );
}

const scanResult: PackageScanResult = {
  projectId: 'p1',
  sections: [
    {
      ecosystem: 'node',
      manager: 'pnpm',
      status: 'ok',
      message: null,
      runtimes: [],
      toolchain: null,
      packages: [
        {
          name: 'zod',
          currentVersion: '4.6.8',
          latestVersion: '4.7.1',
          isOutdated: true,
          isDev: false,
          isInstalled: true,
          manifestPath: 'package.json',
          projectLabel: 'app',
        },
      ],
    },
  ],
};

describe('workaroundRevisits', () => {
  it('checks open workarounds against the package versions and the date', async () => {
    workaround('W001', { dependency: 'zod', ecosystem: 'npm', waitingFor: '4.7.0' });
    workaround('W002', { revisitBy: '2026-01-01' });
    workaround('W003', { dependency: 'zod', waitingFor: '4.7.0' }, 'fixed');
    const scan = vi.fn(async () => scanResult);
    const revisits = await workaroundRevisits('p1', folder, scan, new Date('2026-11-28T10:00:00Z'));
    expect(scan).toHaveBeenCalledWith('p1');
    expect(revisits.map((entry) => [entry.id, entry.state])).toEqual([
      ['W001', 'ready'],
      ['W002', 'due'],
    ]);
  });

  it('never scans the registries when no workaround names a version', async () => {
    workaround('W001', { revisitBy: '2027-01-01' });
    const scan = vi.fn(async () => scanResult);
    const revisits = await workaroundRevisits('p1', folder, scan, new Date('2026-11-28T10:00:00Z'));
    expect(scan).not.toHaveBeenCalled();
    expect(revisits[0].state).toBe('waiting');
  });

  it('still answers by date when the package scan fails', async () => {
    workaround('W001', { dependency: 'zod', waitingFor: '4.7.0', revisitBy: '2026-01-01' });
    const scan = vi.fn(async () => {
      throw new Error('offline');
    });
    const revisits = await workaroundRevisits('p1', folder, scan, new Date('2026-11-28T10:00:00Z'));
    expect(revisits[0].state).toBe('due');
  });
});
