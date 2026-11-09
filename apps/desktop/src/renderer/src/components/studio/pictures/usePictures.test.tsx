import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { picturesView } from './testing/pictureFixtures';
import { usePictures } from './usePictures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async (_options: unknown) => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

beforeEach(() => {
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  toast.success.mockClear();
  toast.error.mockClear();
  toast.info.mockClear();
});

function renderPictures(bridge: Record<string, unknown> = {}) {
  return renderHookWithProviders(() => usePictures('v1'), {
    bridge: { 'studioPictures.view': async () => picturesView(), ...bridge },
  });
}

const price = (count: number) => ({
  usd: 0.1,
  count,
  label: 'GPT Image',
  provider: 'OpenAI',
  basis: 'About $0.05 a picture.',
});

describe('usePictures', () => {
  it('loads the view of the video', async () => {
    const { result } = renderPictures();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.view?.engineLabel).toBe('GPT Image'));
    expect(result.current.loading).toBe(false);
  });

  it.each([
    ['setApp', 'setApp', [{ url: 'http://x' }], [{ videoId: 'v1', url: 'http://x' }]],
    ['startApp', 'startApp', [], ['v1']],
    ['stopApp', 'stopApp', [], ['v1']],
    ['signIn', 'signIn', [], ['v1']],
    ['capture', 'capture', [['a']], ['v1', ['a']]],
    ['cancelCapture', 'cancelCapture', [], ['v1']],
    ['openFolder', 'openFolder', [], ['v1']],
    ['pickFile', 'pickFile', ['a'], ['v1', 'a']],
    ['setFile', 'setFile', ['a', 'C:\\a.png'], ['v1', 'a', 'C:\\a.png']],
    ['captureWindow', 'captureWindow', ['a', 'window:1'], ['v1', 'a', 'window:1']],
  ] as const)('%s calls the bridge for this video', async (action, channel, args, sent) => {
    const { result, bridge } = renderPictures();
    await act(async () => {
      await (result.current[action] as (...a: readonly unknown[]) => Promise<unknown>)(...args);
    });
    expect(bridge.$fn(`studioPictures.${channel}`)).toHaveBeenCalledWith(...sent);
  });

  it('marks what is working by name until it is done', async () => {
    let finish = () => undefined as void;
    const { result } = renderPictures({
      'studioPictures.pickFile': () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    let running = Promise.resolve<unknown>(undefined);
    act(() => {
      running = result.current.pickFile('a');
    });
    expect(result.current.pending).toBe('file-a');
    await act(async () => {
      finish();
      await running;
    });
    expect(result.current.pending).toBeNull();
  });

  it('reports a failure as a toast and carries on', async () => {
    const { result } = renderPictures({
      'studioPictures.startApp': async () => {
        throw new Error('The project has no run command.');
      },
    });
    await act(async () => {
      await expect(result.current.startApp()).resolves.toBeUndefined();
    });
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('The project has no run command.'),
    );
    expect(result.current.pending).toBeNull();
  });

  it('asks for the whole price before making several pictures', async () => {
    const { result, bridge } = renderPictures({
      'studioPictures.estimate': async () => price(3),
    });
    await act(async () => {
      await expect(result.current.generate(['a', 'b', 'c'])).resolves.toBe(true);
    });
    expect(bridge.$fn('studioPictures.estimate')).toHaveBeenCalledWith('v1', ['a', 'b', 'c']);
    expect(confirm).toHaveBeenCalledWith({
      title: 'Make 3 pictures with GPT Image?',
      description: 'This bills your OpenAI account about $0.10. About $0.05 a picture.',
      confirmLabel: 'Make 3',
    });
    expect(bridge.$fn('studioPictures.generate')).toHaveBeenCalledWith('v1', 0.1, ['a', 'b', 'c']);
    expect(toast.success).toHaveBeenCalledWith(
      'GPT Image is making 3 pictures. Each one lands on its scene when it is ready.',
    );
  });

  it('words one picture as one picture', async () => {
    const { result } = renderPictures({ 'studioPictures.estimate': async () => price(1) });
    await act(async () => {
      await result.current.generate(['a']);
    });
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'Make this picture with GPT Image?',
      confirmLabel: 'Make it',
    });
    expect(toast.success).toHaveBeenCalledWith(
      'GPT Image is making the picture. Each one lands on its scene when it is ready.',
    );
  });

  it('does not ask or spend anything when no pictures are left', async () => {
    const { result } = renderPictures({ 'studioPictures.estimate': async () => price(0) });
    await act(async () => {
      await expect(result.current.generate()).resolves.toBe(false);
    });
    expect(toast.info).toHaveBeenCalledWith('There are no pictures left to make.');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('spends nothing when the price is declined', async () => {
    confirm.mockResolvedValue(false);
    const { result, bridge } = renderPictures({ 'studioPictures.estimate': async () => price(2) });
    await act(async () => {
      await expect(result.current.generate()).resolves.toBe(false);
    });
    expect(() => bridge.$fn('studioPictures.generate')).toThrow();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('offers to open the folder after writing PICTURES.md', async () => {
    const written = { filled: 0, unknown: [], markdownPath: 'C:\\p\\PICTURES.md' };
    const { result, bridge } = renderPictures({
      'studioPictures.writeMarkdown': async () => written,
    });
    await act(async () => {
      await expect(result.current.writeMarkdown()).resolves.toEqual(written);
    });
    const [message, options] = toast.success.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe('PICTURES.md is ready in the pictures folder.');
    expect(options.action.label).toBe('Open folder');
    options.action.onClick();
    expect(bridge.$fn('studioPictures.openFolder')).toHaveBeenCalledWith('v1');
  });

  describe('checkFolder', () => {
    const folder = (filled: number, unknown: string[]) => ({
      filled,
      unknown,
      markdownPath: 'C:\\p\\PICTURES.md',
    });

    async function check(result: ReturnType<typeof folder>) {
      const hook = renderPictures({ 'studioPictures.checkFolder': async () => result });
      await act(async () => {
        await hook.result.current.checkFolder();
      });
    }

    it('counts one picture found', async () => {
      await check(folder(1, []));
      expect(toast.success).toHaveBeenCalledWith('1 picture added from the folder.');
    });

    it('counts several pictures found', async () => {
      await check(folder(2, ['stray.png']));
      expect(toast.success).toHaveBeenCalledWith('2 pictures added from the folder.');
    });

    it('names files that matched nothing, the first few of them', async () => {
      await check(folder(0, ['a.png', 'b.png', 'c.png', 'd.png']));
      expect(toast.info).toHaveBeenCalledWith(
        "No file matched a picture's name. Rename one of these to a name in PICTURES.md: a.png, b.png, c.png.",
      );
    });

    it('says when nothing new is there', async () => {
      await check(folder(0, []));
      expect(toast.info).toHaveBeenCalledWith('Nothing new in the pictures folder yet.');
    });
  });
});
