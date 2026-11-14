import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
  const windows = process.platform === 'win32';
  // PowerShell only runs a quoted program path behind its call operator, as in the terminal.
  const node = `${windows ? '& ' : ''}"${process.execPath}"`;

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

  describe.runIf(windows)(
    'on Windows, with the same PowerShell the workspace terminal runs',
    () => {
      const other = realpathSync(mkdtempSync(join(tmpdir(), 'runova studio $app ')));
      // The app below sits in this folder for a few seconds after the test, so removing it waits.
      afterAll(() =>
        rmSync(other, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
      );

      it('runs a command written for the terminal, like Push-Location <folder>; ...; Pop-Location', async () => {
        const lines: string[] = [];
        const started = await capture.startApp({
          key: 'p3',
          folder: process.cwd(),
          command: `Push-Location '${other}'; ${node} -e "console.log('in ' + process.cwd()); console.log('Local: http://localhost:5173/'); setTimeout(() => {}, 3000)"; Pop-Location`,
          onLine: (line) => lines.push(line),
          signal: new AbortController().signal,
        });
        expect(started.url).toBe('http://localhost:5173/');
        expect(lines).toContain(`in ${other}`);
        await capture.stopApp('p3');
      });

      it("passes on the app's own exit code", async () => {
        await expect(
          capture.startApp({
            key: 'p4',
            folder: process.cwd(),
            command: `${node} -e "process.exit(3)"`,
            onLine: () => undefined,
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(/exit code 3/);
      });

      it("says what PowerShell said about a command it cannot find, not cmd's words", async () => {
        const error = await capture
          .startApp({
            key: 'p5',
            folder: process.cwd(),
            command: 'Push-Location .; runova-no-such-tool --dev; Pop-Location',
            onLine: () => undefined,
            signal: new AbortController().signal,
          })
          .catch((e: Error) => e);
        expect(String(error)).toMatch(
          /runova-no-such-tool.*not recognized as the name of a cmdlet/,
        );
        expect(String(error)).not.toMatch(/internal or external command|At line:|CategoryInfo/);
      });
    },
  );
});
