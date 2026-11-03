import {
  createScene,
  type PiperDownloadState,
  type PiperLibraryView,
  piperLibraryView,
  type VoiceEngineView,
} from '@runova/studio';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { document } from '../testing/fixtures';
import { PiperVoiceLibraryDialog } from './PiperVoiceLibraryDialog';
import { VoicePanel } from './VoicePanel';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

beforeEach(() => {
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  toast.error.mockClear();
});

function library(
  installed: string[] = [],
  downloads: [string, PiperDownloadState][] = [],
  engine = true,
): PiperLibraryView {
  return piperLibraryView(engine, installed, new Map(downloads));
}

function renderLibrary(
  options: { view?: PiperLibraryView; lang?: string; used?: (string | null)[] } = {},
) {
  const onOpenDevSetup = vi.fn();
  const view = renderWithProviders(
    <PiperVoiceLibraryDialog
      open
      onOpenChange={() => undefined}
      lang={options.lang ?? 'en'}
      usedVoiceRefs={options.used ?? []}
      onOpenDevSetup={onOpenDevSetup}
    />,
    {
      bridge: {
        'studioAudio.piperLibrary': async () => options.view ?? library(),
        'studioAudio.downloadPiperVoice': async (id: string) =>
          library([], [[id, { running: true, fraction: 0.4, error: null }]]),
        'studioAudio.cancelPiperVoice': async () => library(),
        'studioAudio.removePiperVoice': async () => options.view ?? library(),
      },
    },
  );
  return { ...view, onOpenDevSetup };
}

describe('Piper voice library', () => {
  it("shows the video's language, then every language or whatever was searched for", async () => {
    const { user } = renderLibrary();
    expect(await screen.findByRole('region', { name: 'English (en-GB)' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'English (en-US)' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'German (de-DE)' })).not.toBeInTheDocument();
    const vctk = screen.getByRole('listitem', { name: 'VCTK, medium' });
    expect(within(vctk).getByText('109 speakers')).toBeInTheDocument();
    expect(within(vctk).getByText(/CC BY 4\.0/)).toBeInTheDocument();
    // A voice whose card names no license is offered as non-commercial.
    const amy = screen.getByRole('listitem', { name: 'Amy, low' });
    expect(within(amy).getByText('Non-commercial, license not stated')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Search voices' }), 'thorsten');
    expect(await screen.findByRole('region', { name: 'German (de-DE)' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'English (en-US)' })).not.toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Search voices' }));
    await user.click(screen.getByRole('checkbox', { name: 'Every language' }));
    expect(await screen.findByRole('region', { name: 'Persian (fa-IR)' })).toBeInTheDocument();
  });

  it('downloads a voice and shows how far it is, and stops it', async () => {
    const { user, bridge } = renderLibrary();
    await user.click(await screen.findByRole('button', { name: 'Download VCTK, medium' }));
    expect(bridge.$fn('studioAudio.downloadPiperVoice')).toHaveBeenCalledWith('en_GB-vctk-medium');
    const bar = await screen.findByRole('progressbar', { name: 'Downloading VCTK' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    await user.click(screen.getByRole('button', { name: 'Stop downloading VCTK' }));
    expect(bridge.$fn('studioAudio.cancelPiperVoice')).toHaveBeenCalledWith('en_GB-vctk-medium');
    expect(await screen.findByRole('button', { name: 'Download VCTK, medium' })).toBeEnabled();
  });

  it('says why a download failed and offers to try again', async () => {
    renderLibrary({
      view: library(
        [],
        [['en_US-amy-low', { running: false, fraction: null, error: 'It broke.' }]],
      ),
    });
    const amy = await screen.findByRole('listitem', { name: 'Amy, low' });
    expect(within(amy).getByText('It broke.')).toBeInTheDocument();
    expect(within(amy).getByRole('button', { name: 'Download Amy, low' })).toHaveTextContent(
      'Try again',
    );
  });

  it('warns before removing a voice the video was spoken with', async () => {
    const { user, bridge } = renderLibrary({
      view: library(['en_GB-vctk-medium', 'en_US-amy-low']),
      used: ['piper:en_GB-vctk-medium#12', null],
    });
    await user.click(await screen.findByRole('button', { name: 'Remove VCTK' }));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Remove VCTK?',
        description: expect.stringMatching(/^Scenes in this video were spoken with it/),
      }),
    );
    expect(bridge.$fn('studioAudio.removePiperVoice')).toHaveBeenCalledWith('en_GB-vctk-medium');

    confirm.mockResolvedValue(false);
    await user.click(screen.getByRole('button', { name: 'Remove Amy' }));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: expect.stringMatching(/^Its files are deleted/) }),
    );
    expect(bridge.$fn('studioAudio.removePiperVoice')).toHaveBeenCalledTimes(1);
  });

  it('asks for Piper first, and downloads nothing until it is there', async () => {
    const { user, onOpenDevSetup } = renderLibrary({ view: library([], [], false) });
    expect(
      await screen.findByText(/^Install Piper first, from Agent Tools, Dev Setup \(Studio\)/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download VCTK, medium' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Open Dev Setup' }));
    expect(onOpenDevSetup).toHaveBeenCalled();
  });

  it('says so when no voice matches', async () => {
    const { user } = renderLibrary();
    await user.type(await screen.findByRole('textbox', { name: 'Search voices' }), 'zzzz');
    expect(await screen.findByText('No voices match')).toBeInTheDocument();
  });
});

describe('Get voices in the voice panel', () => {
  const PIPER: VoiceEngineView = {
    id: 'piper',
    label: 'Piper',
    problem: null,
    locked: false,
    keyIn: 'none',
    local: true,
    nonCommercial: false,
    clones: false,
    pricePerMillionChars: null,
    retiresOn: null,
  };

  function renderPanel(engine: VoiceEngineView) {
    const doc = document();
    doc.scenario.scenes = [createScene({ id: 's1', narration: 'Hello there.' })];
    return renderWithProviders(
      <VoicePanel
        videoId="v1"
        document={doc}
        apply={vi.fn(async () => true)}
        adopt={vi.fn(async () => undefined)}
        onOpenDevSetup={vi.fn()}
      />,
      {
        bridge: {
          'studioAudio.engines': async () => [engine],
          'studioAudio.voices': async () => [
            { id: 'en_GB-vctk-medium#0', label: 'VCTK p239, medium', locale: 'en-GB' },
          ],
          'studioAudio.jobs': async () => [],
          'studioAudio.profiles': async () => [],
          'studioAudio.piperLibrary': async () => library(['en_GB-vctk-medium']),
        },
      },
    );
  }

  it('opens the Piper voice library from beside the voice list', async () => {
    const { user } = renderPanel(PIPER);
    await user.click(await screen.findByRole('button', { name: 'Get voices' }));
    expect(await screen.findByRole('dialog', { name: 'Piper voices' })).toBeInTheDocument();
  });

  it('leads to the library when Piper has no voice yet', async () => {
    const { user } = renderPanel({
      ...PIPER,
      problem: 'Download a Piper voice first: Get voices, next to the voice list.',
    });
    const notice = await screen.findByText(/^Download a Piper voice first/);
    const buttons = screen.getAllByRole('button', { name: 'Get voices' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1] as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Piper voices' })).toBeInTheDocument(),
    );
    expect(notice).toBeInTheDocument();
  });
});
