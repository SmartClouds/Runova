import type { ScenePicture } from '@runova/studio';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { fakePictures, picture } from './testing/pictureFixtures';
import { WindowCaptureDialog } from './WindowCaptureDialog';

afterEach(() => {
  vi.useRealTimers();
});

const shot = (id: string, instructions: string): ScenePicture =>
  picture({ id, purpose: `The ${id} screen.`, shot: { target: 'window', instructions } });

const WINDOWS = [
  { id: 'w1', name: 'Shop', thumbnail: 'data:image/png;base64,AA' },
  { id: 'w2', name: 'Editor', thumbnail: 'data:image/png;base64,BB' },
];

function renderDialog(
  shots: ScenePicture[],
  over: { pictures?: ReturnType<typeof fakePictures> } = {},
) {
  const onOpenChange = vi.fn();
  const pictures = over.pictures ?? fakePictures();
  const view = renderWithProviders(
    <WindowCaptureDialog shots={shots} open onOpenChange={onOpenChange} pictures={pictures} />,
    { bridge: { 'studioPictures.windows': async () => WINDOWS } },
  );
  return { onOpenChange, pictures, ...view };
}

/** The countdown runs a second at a time, each step set off by the render of the one before. */
async function runCountdown(): Promise<void> {
  for (const _second of [3, 2, 1]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

/** Picks a window and starts its countdown, under timers the test controls from here on. */
async function pickAndStart(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('radio', { name }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(screen.getByRole('button', { name: 'Capture in 3 s' }));
}

describe('WindowCaptureDialog', () => {
  it('says what to bring up and takes the window after the countdown', async () => {
    const shots = [shot('first', 'Open Preferences'), shot('second', 'Open About')];
    const { pictures } = renderDialog(shots);
    expect(screen.getByRole('heading', { name: 'Capture the app window (1 of 2)' })).toBeDefined();
    expect(screen.getByText('Open Preferences')).toBeInTheDocument();
    expect(screen.getByText('For: The first screen.')).toBeInTheDocument();
    await screen.findByRole('radio', { name: 'Editor' });
    expect(screen.getByRole('button', { name: 'Capture in 3 s' })).toBeDisabled();

    await pickAndStart('Editor');
    expect(screen.getByRole('radio', { name: 'Editor' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Capturing in 3...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
    expect(pictures.captureWindow).not.toHaveBeenCalled();

    await runCountdown();
    expect(pictures.captureWindow).toHaveBeenCalledExactlyOnceWith('first', 'w2');
    expect(screen.getByRole('heading', { name: 'Capture the app window (2 of 2)' })).toBeDefined();
    expect(screen.getByText('Open About')).toBeInTheDocument();
  });

  it('closes after the last window', async () => {
    const { onOpenChange, pictures } = renderDialog([shot('only', 'Open Preferences')]);
    expect(screen.getByRole('heading', { name: 'Capture the app window' })).toBeDefined();
    await pickAndStart('Shop');
    await runCountdown();
    expect(pictures.captureWindow).toHaveBeenCalledWith('only', 'w1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('skips to the next shot, and closes after the last', async () => {
    const shots = [shot('first', 'Open Preferences'), shot('second', 'Open About')];
    const { onOpenChange, pictures } = renderDialog(shots);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByText('Open About')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(pictures.captureWindow).not.toHaveBeenCalled();
  });

  it('falls back to what the picture shows when a shot has no instructions', async () => {
    renderDialog([picture({ id: 'bare', purpose: 'The start screen.', shot: undefined })]);
    expect(await screen.findByText('The start screen.')).toBeInTheDocument();
    expect(screen.queryByText(/^For:/)).toBeNull();
  });

  it('holds the capture while another window is being saved', async () => {
    renderDialog([shot('only', 'Open Preferences')], {
      pictures: fakePictures({ pending: 'window-other' }),
    });
    fireEvent.click(await screen.findByRole('radio', { name: 'Shop' }));
    expect(screen.getByRole('button', { name: 'Capture in 3 s' })).toBeDisabled();
  });

  it('asks for the app to be opened when there are no windows, and looks again', async () => {
    const { bridge } = renderWithProviders(
      <WindowCaptureDialog
        shots={[shot('only', 'Open Preferences')]}
        open
        onOpenChange={vi.fn()}
        pictures={fakePictures()}
      />,
      { bridge: { 'studioPictures.windows': async () => [] } },
    );
    expect(await screen.findByText('No windows to capture')).toBeInTheDocument();
    const windows = bridge.$fn('studioPictures.windows');
    const before = windows.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(windows.mock.calls.length).toBeGreaterThan(before));
  });
});
