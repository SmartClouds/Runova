import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { queueDialog } from '../../test/main/electronMock';
import {
  electronState,
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The Pictures step's channels (E58): each one checks its input and reaches the right part of the
 * service. What the service does with it is covered in the package (pictures.service.test.ts) and
 * in the capture host's own tests, so the service is the stand-in here.
 */

const service = vi.hoisted(() => ({
  calls: [] as { method: string; input: unknown }[],
  answers: new Map<string, unknown>(),
}));

vi.mock('../studio', () => ({
  studioService: () =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => async (input: unknown) => {
          service.calls.push({ method, input });
          return service.answers.get(method);
        },
      },
    ),
}));

const shellAnswer = vi.hoisted(() => ({ openPath: '' }));

vi.mock('electron', async (importOriginal) => {
  const real = await importOriginal<typeof import('electron')>();
  return {
    ...real,
    shell: {
      ...real.shell,
      openPath: async (target: string) => {
        await real.shell.openPath(target);
        return shellAnswer.openPath;
      },
    },
  };
});

// The channels file brings the voice tools and their installers with it. Vitest keeps the
// transformed files between the hooks' imports, so loading them once here moves the cold
// transform out of the first hook's time limit, as in aiAccess.test.ts.
await import('./studio');

const userData = useTempUserData();
expectChannelsCovered(IPC.studioPictures);

const VIDEO = 'v1aaaaaaaaaaaaaa';
const PICTURE = 'p1aaaaaaaaaaaaaa';
const ref = { videoId: VIDEO };
const allowed = { value: true };

beforeEach(async () => {
  allowed.value = true;
  service.calls = [];
  service.answers = new Map();
  shellAnswer.openPath = '';
  await loadIpc(
    () => import('./studio'),
    (m) => m.registerStudioHandlers({ guard: () => allowed.value }),
  );
});

describe('the channels that pass straight to the service', () => {
  const channels: [keyof typeof IPC.studioPictures, string, unknown][] = [
    [
      'plan',
      'startPictures',
      {
        videoId: VIDEO,
        instruction: 'Show the billing page',
        run: { cliId: 'claude-code', model: 'sonnet' },
      },
    ],
    ['view', 'pictures', ref],
    ['setApp', 'setPicturesApp', { videoId: VIDEO, url: 'http://localhost:3000' }],
    ['startApp', 'startPicturesApp', ref],
    ['stopApp', 'stopPicturesApp', ref],
    ['signIn', 'picturesSignIn', ref],
    ['capture', 'capturePictures', { videoId: VIDEO, pictureIds: [PICTURE] }],
    ['cancelCapture', 'cancelCapture', ref],
    [
      'captureWindow',
      'captureWindow',
      { videoId: VIDEO, pictureId: PICTURE, sourceId: 'window:1' },
    ],
    ['estimate', 'picturesEstimate', ref],
    ['generate', 'generatePictures', { videoId: VIDEO, confirmedUsd: 0.05 }],
    ['writeMarkdown', 'writePicturesMarkdown', ref],
    ['checkFolder', 'checkPicturesFolder', ref],
    ['setFile', 'setPictureFile', { videoId: VIDEO, pictureId: PICTURE, path: 'C:\\shot.png' }],
  ];

  it.each(channels)('%s reaches %s', async (channel, method, input) => {
    service.answers.set(method, { answered: method });
    await expect(invoke(IPC.studioPictures[channel], input)).resolves.toEqual({
      answered: method,
    });
    expect(service.calls).toEqual([{ method, input }]);
  });

  it('lists the windows without any input', async () => {
    service.answers.set('captureWindows', [{ id: 'window:1' }]);
    await expect(invoke(IPC.studioPictures.windows)).resolves.toEqual([{ id: 'window:1' }]);
    expect(service.calls).toEqual([{ method: 'captureWindows', input: undefined }]);
  });
});

describe('what the channels refuse', () => {
  it('names the field that is wrong, and never reaches the service', async () => {
    await expect(invoke(IPC.studioPictures.view, { videoId: '' })).rejects.toThrow(
      'That Studio request is not valid (videoId)',
    );
    await expect(
      invoke(IPC.studioPictures.generate, { videoId: VIDEO, confirmedUsd: -1 }),
    ).rejects.toThrow('That Studio request is not valid (confirmedUsd)');
    expect(service.calls).toEqual([]);
  });

  it('says so plainly when the whole request is wrong', async () => {
    await expect(invoke(IPC.studioPictures.view, 'not an object')).rejects.toThrow(
      /^That Studio request is not valid: /,
    );
  });

  it('answers only the main window', async () => {
    allowed.value = false;
    await expect(invokeFrom(fakeWebContents(), IPC.studioPictures.view, ref)).rejects.toThrow(
      'Studio only answers the main window.',
    );
    expect(service.calls).toEqual([]);
  });
});

describe('openFolder', () => {
  it('makes the folder first, since nothing may have been saved there yet', async () => {
    const folder = join(userData.dir, 'video', 'pictures');
    service.answers.set('picturesFolder', folder);
    await invoke(IPC.studioPictures.openFolder, ref);
    expect(service.calls).toEqual([{ method: 'picturesFolder', input: ref }]);
    expect(existsSync(folder)).toBe(true);
    expect(electronState.openedPaths).toEqual([folder]);
  });

  it('passes on why the file manager could not open it', async () => {
    service.answers.set('picturesFolder', join(userData.dir, 'video', 'pictures'));
    shellAnswer.openPath = 'No application is associated with this folder.';
    await expect(invoke(IPC.studioPictures.openFolder, ref)).rejects.toThrow(
      'No application is associated with this folder.',
    );
  });
});

describe('pickFile', () => {
  const pick = { videoId: VIDEO, pictureId: PICTURE };

  it('leaves the picture alone when the user cancels', async () => {
    await expect(invoke(IPC.studioPictures.pickFile, pick)).resolves.toBe(false);
    expect(service.calls).toEqual([]);
  });

  it('leaves the picture alone when the dialog comes back with no file', async () => {
    queueDialog('showOpenDialog', { canceled: false, filePaths: [] });
    await expect(invoke(IPC.studioPictures.pickFile, pick)).resolves.toBe(false);
    expect(service.calls).toEqual([]);
  });

  it('puts the chosen file on the picture', async () => {
    queueDialog('showOpenDialog', { canceled: false, filePaths: ['C:\\shot.webp'] });
    await expect(invoke(IPC.studioPictures.pickFile, pick)).resolves.toBe(true);
    expect(service.calls).toEqual([
      { method: 'setPictureFile', input: { ...pick, path: 'C:\\shot.webp' } },
    ]);
    // No window asked, so the dialog stands by itself.
    const [call] = electronState.dialogCalls;
    expect(call?.args).toHaveLength(1);
    expect(call?.args[0]).toMatchObject({
      title: 'Pick a picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
  });

  it('opens the dialog over the window that asked', async () => {
    const win = new BrowserWindow();
    queueDialog('showOpenDialog', { canceled: false, filePaths: ['C:\\shot.png'] });
    await invokeFrom(win.webContents as never, IPC.studioPictures.pickFile, pick);
    expect(electronState.dialogCalls[0]?.args[0]).toBe(win);
  });

  it('checks both ids before showing anything', async () => {
    await expect(
      invoke(IPC.studioPictures.pickFile, { videoId: VIDEO, pictureId: '' }),
    ).rejects.toThrow('That Studio request is not valid (pictureId)');
    expect(electronState.dialogCalls).toEqual([]);
  });
});
