import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupPlan, restorePlan } from './dump.js';

/**
 * The SQL Server scripts in a real sh, with a stand-in sqlcmd that does what SQL Server does with
 * the file named in the query. On a server target they run on a shared machine, where a fixed
 * name in /tmp is one another account can create first and read or swap.
 */

const sh = spawnSync('sh', ['-c', 'exit 0']);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The path sh sees: Git's sh on Windows reads C:\x as /c/x. */
function shPath(path: string): string {
  return process.platform === 'win32'
    ? path
        .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
        .replace(/\\/g, '/')
    : path;
}

function fakeSqlcmd(): { bin: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'runova-mssql-dump-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'paths.log');
  // BACKUP writes the database into the named file, RESTORE reads it back.
  writeFileSync(
    join(bin, 'sqlcmd'),
    [
      '#!/bin/sh',
      'while [ $# -gt 0 ]; do [ "$1" = -Q ] && q="$2"; shift; done',
      `f=$(printf '%s' "$q" | sed -n "s/.*DISK = N'\\([^']*\\)'.*/\\1/p")`,
      `echo "$f" >> '${shPath(log)}'`,
      'case "$q" in BACKUP*) printf DATABASE > "$f" ;; RESTORE*) cat "$f" >&2 ;; esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'sqlcmd'), 0o755);
  return { bin, log };
}

function run(script: string, bin: string, input: string) {
  return spawnSync('sh', ['-c', script], {
    input,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${shPath(bin)}:${process.env.PATH ?? ''}` },
  });
}

const options = {
  engine: 'mssql' as const,
  user: 'sa',
  database: 'shop',
  host: '127.0.0.1',
  port: 1433,
};

describe.runIf(!sh.error)('the SQL Server backup and restore scripts', () => {
  // Real shells: Git's sh on Windows takes a while to start each of its processes.
  it('stage each run in a fresh folder of its own, never a fixed name in /tmp', {
    timeout: 60_000,
  }, () => {
    const { bin, log } = fakeSqlcmd();

    const first = run(backupPlan(options).script, bin, 'secret\n');
    const second = run(backupPlan(options).script, bin, 'secret\n');
    const restored = run(restorePlan(options).script, bin, 'secret\nDUMP');

    expect(first.status).toBe(0);
    expect(first.stdout).toBe('DATABASE');
    expect(second.stdout).toBe('DATABASE');
    expect(restored.status).toBe(0);
    expect(restored.stderr).toContain('DUMP');
    // Each line: the staged path, then whether it or its folder still exists once the run ended.
    const lines = spawnSync(
      'sh',
      [
        '-c',
        'while IFS= read -r p; do [ -e "$p" ] || [ -e "${p%/*}" ] && l=1 || l=0; echo "$p $l"; done < "$1"',
        '-',
        shPath(log),
      ],
      { encoding: 'utf8' },
    )
      .stdout.trim()
      .split('\n');
    const paths = lines.map((line) => line.split(' ')[0]);
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
    for (const line of lines) {
      expect(line).not.toMatch(/^\/tmp\/runova-(backup|restore)\.bak /);
      expect(line.endsWith(' 0')).toBe(true);
    }
  });
});
