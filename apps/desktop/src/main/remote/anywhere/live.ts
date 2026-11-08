import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { app, safeStorage, systemPreferences } from 'electron';
import type { AnywherePlatform, AnywhereState } from '../../../shared/anywhere';
import { IPC } from '../../../shared/ipcChannels';
import type { AccountRuntime } from '../../account/runtime';
import { aiAccessActivity } from '../../aiAccess/audit';
import { sendToWindow } from '../../ipc/send';
import { getMainWindow } from '../../mainWindow';
import { showOsNotification } from '../../notifications/osNotification';
import { decryptSecret, encryptSecret, registerSealedSecretStore } from '../../ssh/vault';
import { InputInjector } from '../inputInjector';
import { liveManageDeps } from '../manage/liveDeps';
import { createManageMethods } from '../manage/methods';
import { createManageSession, type ManageAudit } from '../manage/session';
import { remoteManager } from '../manager';
import { createAgentInstaller } from './agentInstaller';
import { createAnywhereApi } from './api';
import { websiteAnywhereHub } from './hub';
import { createRelayOpener } from './relay';
import { createRtcLinkOpener, type RtcLinkOpener } from './rtcLinks';
import { createSavedPasswords } from './savedPasswords';
import { type AnywhereService, createAnywhereService } from './service';
import { createAnywhereStore } from './settings';
import { anywhereWindows, syncHostBar, syncRequestWindow } from './windows';

function dataFile(name: string): string {
  return join(app.getPath('userData'), 'data', name);
}

function jsonFile(name: string) {
  return {
    read: async (): Promise<unknown> => {
      try {
        return JSON.parse(await readFile(dataFile(name), 'utf-8'));
      } catch {
        return null;
      }
    },
    write: async (value: unknown): Promise<void> => {
      const file = dataFile(name);
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await rename(temp, file);
    },
  };
}

// biome-ignore lint/suspicious/noConsole: main has no logger of its own; this is how the account features report.
const log = (message: string): void => console.warn(message);

function platform(): AnywherePlatform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

let service: AnywhereService | null = null;
/** Only asked what it supports; it never starts a helper. */
const injectorCheck = new InputInjector();
let links: RtcLinkOpener | null = null;
let lastState: AnywhereState | null = null;

/** Every window that shows Anywhere: the main one, the request window and the host bar. */
function broadcast(channel: string, payload: unknown): void {
  for (const window of [getMainWindow(), ...anywhereWindows()])
    sendToWindow(window, channel, payload);
}

const manageMethods = createManageMethods(liveManageDeps);

const AUDIT_RISK = { read: 'read', write: 'write', danger: 'sensitive' } as const;
const AUDIT_OUTCOME = { ok: 'auto', failed: 'failed', forbidden: 'refused' } as const;

/** What phones changed, or tried to, goes in the same record as what agents did. */
const recordPhoneActivity: ManageAudit = ({ phone, method, risk, outcome }) => {
  void aiAccessActivity
    .record({
      tool: method,
      toolTitle: method,
      area: null,
      risk: AUDIT_RISK[risk],
      agent: phone,
      callerKind: 'external',
      projectId: null,
      projectName: null,
      outcome: AUDIT_OUTCOME[outcome],
    })
    .catch(() => undefined);
};

/** The app's one Anywhere service (E61), made on first use against the account runtime. */
export function getAnywhere(runtime: AccountRuntime): AnywhereService {
  if (service) return service;

  const hub = websiteAnywhereHub({
    siteUrl: runtime.siteUrl,
    accessToken: () => runtime.accessToken(),
    log,
  });

  const rtc = createRtcLinkOpener(
    {
      startPeer: (input) => sendToWindow(getMainWindow(), IPC.anywhere.onLinkStart, input),
      deliverSignal: (sessionId, payload) =>
        sendToWindow(getMainWindow(), IPC.anywhere.onLinkSignal, { sessionId, payload }),
      sendFrame: (sessionId, frame) =>
        sendToWindow(getMainWindow(), IPC.anywhere.onLinkFrame, { sessionId, frame }),
      stopPeer: (sessionId, reason) =>
        sendToWindow(getMainWindow(), IPC.anywhere.onLinkStop, { sessionId, reason }),
    },
    {
      relay: createRelayOpener({
        siteUrl: runtime.siteUrl,
        ticket: (sessionId) => hub.relayTicket(sessionId),
      }),
    },
  );
  links = rtc;

  const saved = createSavedPasswords(jsonFile('anywhere-saved.json'), {
    encrypt: encryptSecret,
    decrypt: decryptSecret,
  });
  registerSealedSecretStore(saved.sealed);

  service = createAnywhereService({
    api: createAnywhereApi(runtime.api),
    hub,
    store: createAnywhereStore({
      ...jsonFile('anywhere.json'),
      canSeal: () => safeStorage.isEncryptionAvailable(),
      seal: (plain) => safeStorage.encryptString(plain).toString('base64'),
      open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
    }),
    links: rtc,
    manager: remoteManager,
    manage: {
      attach: (link, phone) =>
        createManageSession({
          link,
          phone,
          deviceName: hostname() || 'This computer',
          methods: manageMethods,
          audit: recordPhoneActivity,
        }),
    },
    passwords: saved,
    account: async () => {
      const status = await runtime.status();
      if (status.state !== 'signed-in') return null;
      return {
        deviceId: status.deviceId,
        displayName: status.account.displayName,
        email: status.account.email,
      };
    },
    device: { name: hostname() || 'This computer', platform: platform() },
    announce: (state) => {
      lastState = state;
      broadcast(IPC.anywhere.onState, state);
      syncRequestWindow(state.incoming.length);
    },
    showIncoming: () => undefined,
    hostedChanged: (hosted) => syncHostBar(hosted.length),
    notify: (title, body) => {
      showOsNotification({ title, body, route: '/remote?tab=anywhere' });
    },
    log,
    checkAccount: () => {
      void runtime.profile().catch(() => undefined);
    },
    siteUrl: runtime.siteUrl,
    agent: createAgentInstaller({
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      exists: existsSync,
      run: (command, args) =>
        new Promise((resolve) => {
          const child = spawn(command, args, { windowsHide: true });
          let stdout = '';
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf-8');
          });
          child.on('error', () => resolve({ code: -1, stdout }));
          child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
        }),
      writePrivateFile: async (content) => {
        const file = dataFile(`agent-config-${randomUUID()}.json`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, { encoding: 'utf-8', mode: 0o600 });
        return file;
      },
      removeFile: (path) => unlink(path),
      copyExecutable: async (path) => {
        const file = dataFile(`agent-setup-${randomUUID()}`);
        await mkdir(dirname(file), { recursive: true });
        await copyFile(path, file);
        await chmod(file, 0o700);
        return file;
      },
    }),
    readiness: () => {
      const needs: ('accessibility' | 'screen')[] = [];
      if (process.platform === 'darwin') {
        if (!systemPreferences.isTrustedAccessibilityClient(false)) needs.push('accessibility');
        if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') needs.push('screen');
      }
      return { controlUnavailable: injectorCheck.unsupportedReason(), needs };
    },
  });
  return service;
}

/** The link opener, for the renderer's WebRTC peer to report back to. */
export function anywhereLinks(): RtcLinkOpener | null {
  return links;
}

export function anywhereState(): AnywhereState | null {
  return lastState ?? service?.state() ?? null;
}
