import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeBrowserWindow } from '../../../test/main/electronMock';
import { offerWindows, syncOfferWindow } from './window';

afterEach(() => {
  syncOfferWindow(0);
  vi.restoreAllMocks();
});

describe('the incoming files window', () => {
  it('opens on top of everything at the incoming files page while an offer waits', () => {
    const load = vi.spyOn(FakeBrowserWindow.prototype, 'loadFile');

    syncOfferWindow(1);

    const [window] = offerWindows() as unknown as FakeBrowserWindow[];
    expect(window.options).toMatchObject({
      alwaysOnTop: true,
      frame: false,
      title: 'Incoming files',
    });
    expect(load).toHaveBeenCalledWith(expect.any(String), { hash: '/incoming-files' });
  });

  it('keeps one window however many offers wait, and closes it when none do', () => {
    syncOfferWindow(1);
    syncOfferWindow(3);

    expect(offerWindows()).toHaveLength(1);

    syncOfferWindow(0);
    expect(offerWindows()).toHaveLength(0);
  });
});
