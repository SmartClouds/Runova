import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunovaBridge, type FakeBridge } from '../../../../test/renderer/runovaBridge';
import { RecoveryPhraseCard } from './RecoveryPhraseCard';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'.split(
    ' ',
  );
const PHRASE = { id: 'A'.repeat(22), words: WORDS };

let bridge: FakeBridge;

beforeEach(() => {
  vi.clearAllMocks();
  bridge = createRunovaBridge({
    'phrase.qr': { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    'phrase.copy': { clearsAt: Date.now() + 30_000 },
    'phrase.save': { path: 'C:\\Users\\me\\phrase.txt' },
  });
  Object.assign(window, { runova: bridge });
});

describe('RecoveryPhraseCard', () => {
  it('keeps the words hidden until asked, then shows all 24 in order', () => {
    render(<RecoveryPhraseCard phrase={PHRASE} />);

    expect(screen.queryByRole('list', { name: 'Recovery phrase' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show the words/ }));

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(24);
    expect(items[0]).toHaveTextContent('1legal');
    expect(items[23]).toHaveTextContent('24title');
  });

  it('hides the words again when the window loses focus', () => {
    render(<RecoveryPhraseCard phrase={PHRASE} />);
    fireEvent.click(screen.getByRole('button', { name: /Show the words/ }));

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(screen.queryByRole('list', { name: 'Recovery phrase' })).toBeNull();
  });

  it('keeps the window out of screenshots while it is on screen', () => {
    const { unmount } = render(<RecoveryPhraseCard phrase={PHRASE} />);
    expect(bridge.$fn('phrase.protect')).toHaveBeenCalledWith(true);

    unmount();
    expect(bridge.$fn('phrase.protect')).toHaveBeenLastCalledWith(false);
  });

  it('copies by id and says when the clipboard clears', async () => {
    render(<RecoveryPhraseCard phrase={PHRASE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(bridge.$fn('phrase.copy')).toHaveBeenCalledWith(PHRASE.id));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/clears in 30 seconds/)),
    );
  });

  it('saves to a file by id and says where', async () => {
    render(<RecoveryPhraseCard phrase={PHRASE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save to a file' }));

    await waitFor(() => expect(bridge.$fn('phrase.save')).toHaveBeenCalledWith(PHRASE.id));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('phrase.txt')),
    );
  });

  it('says nothing when the save dialog is cancelled, and shows an error when it fails', async () => {
    const save = vi.fn(async () => null);
    bridge.$set('phrase.save', save);
    render(<RecoveryPhraseCard phrase={PHRASE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save to a file' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();

    bridge.$set('phrase.copy', () =>
      Promise.reject(new Error('That recovery phrase is no longer there.')),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That recovery phrase is no longer there.'),
    );
  });

  it('shows the QR code from the main process, behind the same reveal', async () => {
    render(<RecoveryPhraseCard phrase={PHRASE} />);

    fireEvent.click(screen.getByRole('button', { name: 'QR code' }));
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show the QR code/ }));

    const image = await screen.findByRole('img', { name: /QR code of your recovery phrase/ });
    expect(image).toHaveAttribute('src', 'data:image/svg+xml;base64,PHN2Zy8+');
    expect(bridge.$fn('phrase.qr')).toHaveBeenCalledWith(PHRASE.id);
    expect(screen.getByText(/Runova app on your phone/)).toBeInTheDocument();
  });
});
