import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { app, screen } from 'electron';
import type { RemoteInputEvent } from '../../shared/remoteProtocol';
import {
  type InputBackend,
  MAC_HELPER,
  macCommands,
  pickInputBackend,
  type ScreenGeometry,
  WINDOWS_HELPER,
  windowsCommands,
  X11_HELPER,
  x11Commands,
} from './input/backends';

/**
 * Injects mouse/keyboard input into the host OS on behalf of a remote controller.
 *
 * Each OS gets a long-lived helper process fed one single-line command per event over stdin (see
 * `input/backends.ts`): PowerShell on Windows, `osascript` on macOS, `python3` with XTest on X11.
 * Keeping one process alive avoids the per-event cost of spawning, which is what makes real-time
 * control feel responsive. No native npm module is required.
 *
 * Where no backend applies (Wayland, or no display at all) it reports itself unsupported, with the
 * reason, and the host is view only.
 */
export class InputInjector {
  private proc: ChildProcessByStdio<Writable, null, null> | null = null;
  private readonly backend: InputBackend;

  constructor(
    platform: string = process.platform,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.backend = pickInputBackend(platform, env);
  }

  isSupported(): boolean {
    return this.backend.kind !== 'none';
  }

  /** Why control is not available here, or null when it is. */
  unsupportedReason(): string | null {
    return this.backend.kind === 'none' ? this.backend.reason : null;
  }

  start(): void {
    if (this.proc || this.backend.kind === 'none') return;
    const dir = app.getPath('userData');
    switch (this.backend.kind) {
      case 'windows': {
        const script = join(dir, 'remote-input-helper.ps1');
        writeFileSync(script, WINDOWS_HELPER, 'utf-8');
        this.proc = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
          { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
        );
        break;
      }
      case 'macos': {
        const script = join(dir, 'remote-input-helper.js');
        writeFileSync(script, MAC_HELPER, 'utf-8');
        this.proc = spawn('/usr/bin/osascript', ['-l', 'JavaScript', script], {
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        break;
      }
      case 'x11': {
        const script = join(dir, 'remote-input-helper.py');
        writeFileSync(script, X11_HELPER, 'utf-8');
        this.proc = spawn('python3', ['-I', script], { stdio: ['pipe', 'ignore', 'ignore'] });
        break;
      }
    }
    this.proc?.on('exit', () => {
      this.proc = null;
    });
    this.proc?.on('error', () => {
      this.proc = null;
    });
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.write('Q\n');
      this.proc.stdin.end();
    } catch {
      // process may already be gone
    }
    this.proc.kill();
    this.proc = null;
  }

  apply(event: RemoteInputEvent): void {
    if (!this.proc) return;
    const cmds = this.toCommands(event);
    if (cmds.length === 0) return;
    try {
      this.proc.stdin.write(cmds.map((c) => `${c}\n`).join(''));
    } catch {
      // dropped keystroke on a dying helper, the next start() re-establishes it
    }
  }

  private toCommands(event: RemoteInputEvent): string[] {
    const geometry = this.geometry();
    switch (this.backend.kind) {
      case 'windows':
        return windowsCommands(event, geometry);
      case 'macos':
        return macCommands(event, geometry);
      case 'x11':
        return x11Commands(event, geometry);
      default:
        return [];
    }
  }

  /** The primary display, which is the surface the capturer picks. */
  private geometry(): ScreenGeometry {
    const display = screen.getPrimaryDisplay();
    return {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.size.width,
      height: display.size.height,
      scaleFactor: display.scaleFactor,
    };
  }
}
