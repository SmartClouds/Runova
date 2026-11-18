import { EMPTY_FILE_SEND_STATE, type SendOfferView } from '@shared/fileSend';
import { formatBytes } from '@shared/remoteProtocol';
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileSendStore } from '@/stores/fileSendStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { IncomingFilesRoute } from './IncomingFilesRoute';

const NOW = new Date('2026-11-18T10:00:00Z').getTime();

function offer(change: Partial<SendOfferView> = {}): SendOfferView {
  return {
    batchId: 'b1',
    peer: {
      name: 'Ali Rezaei',
      email: 'ali@example.com',
      deviceName: "Ali's laptop",
      platform: 'macos',
      kind: 'computer',
      relation: 'teammate',
      remoteId: '482193775',
    },
    note: 'The photos from Friday',
    fileCount: 35,
    totalBytes: 122_100_000,
    entries: [
      { name: 'report.pdf', kind: 'file', size: 2_100_000, fileCount: 1 },
      { name: 'Holiday', kind: 'folder', size: 120_000_000, fileCount: 34 },
    ],
    folder: 'C:\\Users\\sam\\Downloads',
    freeBytes: 50_000_000_000,
    receivedAt: NOW,
    expiresAt: NOW + 52_000,
    ...change,
  };
}

function show(offers: SendOfferView[], bridge: Record<string, unknown> = {}) {
  const view = renderWithProviders(<IncomingFilesRoute />, { bridge });
  act(() => useFileSendStore.getState().set({ ...EMPTY_FILE_SEND_STATE, available: true, offers }));
  return view;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});
afterEach(() => vi.useRealTimers());

describe('the incoming files window', () => {
  it('asks with who sends, what, and where it goes', () => {
    show([offer()]);

    expect(
      screen.getByRole('heading', { name: 'Ali Rezaei wants to send you 35 files' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Teammate')).toBeInTheDocument();
    expect(screen.getByText("From Ali's laptop")).toBeInTheDocument();
    expect(screen.getByText('The photos from Friday')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText(`34 files, ${formatBytes(120_000_000)}`)).toBeInTheDocument();
    expect(screen.getByText(`35 files, ${formatBytes(122_100_000)}`)).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\sam\\Downloads')).toBeInTheDocument();
    expect(screen.getByText('52 s')).toBeInTheDocument();
  });

  it('does not put Accept first, so a stray key never takes files', () => {
    show([offer()]);

    expect(screen.getByRole('button', { name: 'Accept' })).not.toHaveFocus();
  });

  it('accepts', async () => {
    const { user, bridge } = show([offer()]);

    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(bridge.$fn('fileSend.respond')).toHaveBeenCalledWith('b1', {
      accept: true,
      alwaysAcceptOwn: false,
    });
  });

  it('declines with the button, or with Escape', async () => {
    const { user, bridge } = show([offer()]);

    await user.keyboard('{Escape}');
    expect(bridge.$fn('fileSend.respond')).toHaveBeenCalledWith('b1', { accept: false });

    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(bridge.$fn('fileSend.respond')).toHaveBeenCalledTimes(2);
  });

  it('saves them somewhere else when asked', async () => {
    const { user } = show([offer()], { 'fileSend.chooseFolder': async () => 'D:\\Inbox' });

    await user.click(screen.getByRole('button', { name: 'Change' }));

    expect(screen.getByText('D:\\Inbox')).toBeInTheDocument();
  });

  it('will not accept where there is no room, until another folder is picked', async () => {
    const { user } = show([offer({ freeBytes: 1_000_000 })], {
      'fileSend.chooseFolder': async () => 'D:\\Inbox',
    });

    expect(screen.getByText(/There is not enough room/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
  });

  it('offers to take files from my own devices without asking from now on', async () => {
    const own = offer();
    own.peer = { ...own.peer, relation: 'own', name: 'Sam' };
    const { user, bridge } = show([own]);

    await user.click(
      screen.getByRole('checkbox', { name: 'Always accept files from my own devices' }),
    );
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(bridge.$fn('fileSend.respond')).toHaveBeenCalledWith('b1', {
      accept: true,
      alwaysAcceptOwn: true,
    });
  });

  it('says how many more are waiting', () => {
    show([offer(), offer({ batchId: 'b2' })]);

    expect(screen.getByText('1 more waiting')).toBeInTheDocument();
  });

  it('says why accepting did not work', async () => {
    const { user } = show([offer()], {
      'fileSend.respond': () => Promise.reject(new Error('There is not enough room in D:\\.')),
    });

    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(await screen.findByText('There is not enough room in D:\\.')).toBeInTheDocument();
  });

  it('shows nothing once nothing is waiting', () => {
    const { container } = show([]);

    expect(container).toBeEmptyDOMElement();
  });
});
