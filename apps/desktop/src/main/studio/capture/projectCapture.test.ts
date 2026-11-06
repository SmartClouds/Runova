import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createProjectCapture, detectLocalUrl } from './projectCapture';

/** The project's app for the Pictures step: its address from what it prints, and its process. */

describe('detectLocalUrl', () => {
  it('finds the address dev servers print', () => {
    expect(detectLocalUrl('  \u001b[32m➜\u001b[39m  Local:   http://localhost:5173/')).toBe(
      'http://localhost:5173/',
    );
    expect(detectLocalUrl('- Local:        http://localhost:3000')).toBe('http://localhost:3000');
    expect(detectLocalUrl('Server running at http://127.0.0.1:8080/.')).toBe(
      'http://127.0.0.1:8080/',
    );
    expect(detectLocalUrl('On Your Network:  http://192.168.1.4:3000')).toBeNull();
    expect(detectLocalUrl('compiled successfully')).toBeNull();
  });
});

describe('startApp', () => {
  const killed: ChildProcess[] = [];
  const capture = createProjectCapture({
    env: async () => process.env,
    killTree: (child) => {
      killed.push(child);
      child.kill();
    },
  });
  const node = `"${process.execPath}"`;

  it('resolves with the address the command prints, and stops it after', async () => {
    const lines: string[] = [];
    const started = await capture.startApp({
      key: 'p1',
      folder: process.cwd(),
      command: `${node} -e "console.log('ready'); console.log('  Local: http://localhost:4321/'); setInterval(() => {}, 1000)"`,
      onLine: (line) => lines.push(line),
      signal: new AbortController().signal,
    });
    expect(started.url).toBe('http://localhost:4321/');
    expect(lines).toContain('ready');
    await capture.stopApp('p1');
    expect(killed).toHaveLength(1);
  });

  it('rejects with what the command said when it exits first', async () => {
    await expect(
      capture.startApp({
        key: 'p2',
        folder: process.cwd(),
        command: `${node} -e "console.error('Missing script: dev'); process.exit(1)"`,
        onLine: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exit code 1.*Missing script: dev/);
  });
});
