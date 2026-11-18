import { EMPTY_FILE_SEND_STATE, type FileSendState } from '@shared/fileSend';
import { afterEach, describe, expect, it } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { initFileSend, useFileSendStore } from './fileSendStore';

const online: FileSendState = { ...EMPTY_FILE_SEND_STATE, available: true, status: 'online' };

let stop: () => void = () => undefined;
afterEach(() => stop());

describe('the send files store', () => {
  it('reads the state once, then follows what main announces', async () => {
    const bridge = installRunovaBridge({ 'fileSend.getState': online });

    stop = initFileSend();
    await Promise.resolve();
    await Promise.resolve();
    expect(useFileSendStore.getState()).toMatchObject({ loaded: true, state: { available: true } });

    bridge.$emit('fileSend.onState', { ...online, websiteOutdated: true });
    expect(useFileSendStore.getState().state.websiteOutdated).toBe(true);

    stop();
    expect(bridge.$listenerCount('fileSend.onState')).toBe(0);
  });

  it('keeps the device picked and the note while the person looks elsewhere', () => {
    useFileSendStore.getState().pick('482193775');
    useFileSendStore.getState().setNote('For the review');

    expect(useFileSendStore.getState()).toMatchObject({
      picked: '482193775',
      note: 'For the review',
    });
  });
});
