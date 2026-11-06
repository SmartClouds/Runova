import type {
  PicturesView as PicturesViewData,
  ScenePicture,
  StudioDocument,
} from '@runova/studio';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { PictureSettingsFields } from '../settings/PictureSettingsFields';
import { settings, withScenes } from '../testing/fixtures';
import { PicturesView } from './PicturesView';
import { StepBar } from './StepBar';
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
});

const picture = (over: Partial<ScenePicture> & Pick<ScenePicture, 'id'>): ScenePicture => ({
  purpose: 'The settings page, pointing at Save.',
  source: 'screenshot',
  status: 'planned',
  shot: { target: 'route', path: '/settings', viewport: 'desktop' },
  fileName: `scene-01-${over.id}.png`,
  mediaHash: null,
  genJobId: null,
  error: null,
  ...over,
});

function planned(): StudioDocument {
  const doc = withScenes('Settings', 'Done');
  doc.scenario.scenes[0]!.pictures = [
    picture({ id: 'shot' }),
    picture({
      id: 'gen',
      source: 'generate',
      shot: undefined,
      prompt: 'A calm desk at dawn, no text.',
    }),
  ];
  doc.scenario.scenes[1]!.pictures = [
    picture({ id: 'done', status: 'ready', mediaHash: 'a'.repeat(64) }),
    picture({ id: 'bad', status: 'failed', error: 'The page did not load: 404.' }),
  ];
  return doc;
}

function view(over: Partial<PicturesViewData> = {}): PicturesViewData {
  return {
    app: {
      project: {
        id: 'p1',
        name: 'Shop',
        runCommands: [{ id: 'dev', label: 'dev', command: 'npm run dev' }],
      },
      runCommandId: 'dev',
      url: null,
      status: 'stopped',
      startedByStudio: false,
      error: null,
      output: [],
    },
    job: null,
    engine: 'openai',
    engineReady: true,
    engineLabel: 'GPT Image',
    folder: 'C:\\videos\\shop\\pictures',
    ...over,
  };
}

function Harness(props: {
  document: StudioDocument;
  onPlan?: () => Promise<boolean>;
  onOpenSettings?: (tab: 'agents' | 'ai') => void;
}) {
  const pictures = usePictures('v1');
  return (
    <PicturesView
      videoId="v1"
      document={props.document}
      apply={vi.fn(async () => true)}
      pictures={pictures}
      busy={false}
      planning={false}
      run={{}}
      onRunChange={vi.fn()}
      onPlan={props.onPlan ?? vi.fn(async () => true)}
      onOpenSettings={props.onOpenSettings ?? vi.fn()}
    />
  );
}

function renderView(document: StudioDocument, data: PicturesViewData = view(), extra = {}) {
  return renderWithProviders(<Harness document={document} {...extra} />, {
    bridge: {
      'studioPictures.view': async () => data,
      'studioPictures.capture': async () => ({
        running: true,
        done: 0,
        total: 2,
        current: null,
        failed: 0,
      }),
      'studioPictures.estimate': async () => ({
        usd: 0.053,
        count: 1,
        label: 'GPT Image',
        provider: 'OpenAI',
        basis: 'About $0.053 for one medium quality picture.',
      }),
      'studioPictures.generate': async () => undefined,
      'studioPictures.writeMarkdown': async () => ({
        filled: 0,
        unknown: [],
        markdownPath: 'C:\\videos\\shop\\pictures\\PICTURES.md',
      }),
    },
  });
}

describe('PicturesView', () => {
  it('asks for the scenario first when there are no scenes', () => {
    renderView(withScenes());
    expect(screen.getByText('Write the scenario first')).toBeInTheDocument();
  });

  it('starts planning with the AI from an empty plan', async () => {
    const onPlan = vi.fn(async () => true);
    renderView(withScenes('Settings'), view(), { onPlan });
    fireEvent.change(screen.getByLabelText('Anything particular to show (optional)'), {
      target: { value: 'Show the AI settings' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Plan pictures with AI/ }));
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith('Show the AI settings'));
  });

  it('shows each picture with its state, and the batch actions that fit what is left', async () => {
    renderView(planned());
    expect(await screen.findByText('1 of 4 ready')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    const scene2 = screen.getByRole('region', { name: 'Scene 2 pictures' });
    expect(within(scene2).getByText('1 of 2 ready')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Picture scene-01-shot.png: To do/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Picture scene-01-done.png: Ready/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Picture scene-01-bad.png: Failed/ }),
    ).toBeInTheDocument();
    // Two page shots left (one failed, one to do) and one AI picture.
    expect(
      await screen.findByRole('button', { name: /Capture 2 screenshots/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Make 1 with GPT Image/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Write PICTURES.md/ })).toBeInTheDocument();
  });

  it('captures the screenshots', async () => {
    const { bridge } = renderView(planned());
    fireEvent.click(await screen.findByRole('button', { name: /Capture 2 screenshots/ }));
    await waitFor(() =>
      expect(bridge.$fn('studioPictures.capture')).toHaveBeenCalledWith('v1', undefined),
    );
  });

  it('shows the whole price once and makes the pictures at the price agreed', async () => {
    const { bridge } = renderView(planned());
    fireEvent.click(await screen.findByRole('button', { name: /Make 1 with GPT Image/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'Make this picture with GPT Image?',
      description: expect.stringContaining('This bills your OpenAI account about $0.05.'),
    });
    await waitFor(() =>
      expect(bridge.$fn('studioPictures.generate')).toHaveBeenCalledWith('v1', 0.053, undefined),
    );
  });

  it('sends nothing when the price is declined', async () => {
    confirm.mockResolvedValue(false);
    const { bridge } = renderView(planned());
    fireEvent.click(await screen.findByRole('button', { name: /Make 1 with GPT Image/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(() => bridge.$fn('studioPictures.generate')).toThrow();
  });

  it('says why AI pictures wait when picture making is off, and links to the setting', async () => {
    const onOpenSettings = vi.fn();
    renderView(planned(), view({ engine: 'off', engineReady: false, engineLabel: null }), {
      onOpenSettings,
    });
    expect(await screen.findByText(/Picture making is off/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make 1 with/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Studio settings' }));
    expect(onOpenSettings).toHaveBeenCalledWith('agents');
  });

  it('shows the app to capture, and leaves screenshots out without a project', async () => {
    renderView(planned());
    expect(
      await screen.findByRole('region', { name: 'The Shop app for screenshots' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start the app/ })).toBeInTheDocument();
  });

  it('reports a capture going on as it goes', async () => {
    renderView(
      planned(),
      view({
        job: {
          running: true,
          done: 1,
          total: 2,
          current: { pictureId: 'bad', label: '/settings' },
          failed: 0,
        },
        app: { ...view().app, status: 'running', url: 'http://localhost:5173' },
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Capturing 2 of 2: /settings');
    expect(
      screen.getByRole('button', { name: /Picture scene-01-bad.png: Capturing/ }),
    ).toBeInTheDocument();
  });
});

describe('StepBar', () => {
  it('shows how far each step is and opens it', () => {
    const onOpen = vi.fn();
    const doc = planned();
    renderWithProviders(<StepBar document={doc} current="pictures" onOpen={onOpen} />);
    const nav = screen.getByRole('navigation', { name: 'Steps of the video' });
    expect(
      within(nav).getByRole('button', { name: 'Scenario: 2 scenes, done' }),
    ).toBeInTheDocument();
    const pictures = within(nav).getByRole('button', { name: 'Pictures: 1 of 4 ready' });
    expect(pictures).toHaveAttribute('aria-current', 'step');
    fireEvent.click(within(nav).getByRole('button', { name: 'Animation: 0 of 2 scenes' }));
    expect(onOpen).toHaveBeenCalledWith('animation');
  });
});

describe('PictureSettingsFields', () => {
  it('picks GPT Image by default, with its quality and price, and can turn it off', async () => {
    const onChange = vi.fn();
    renderWithProviders(<PictureSettingsFields data={settings()} onChange={onChange} />, {
      bridge: {
        'studioAudio.engines': async () => [{ id: 'openai', problem: null }],
      },
    });
    const engine = screen.getByRole('radiogroup', { name: 'Make the other pictures with' });
    expect(within(engine).getByRole('radio', { name: 'GPT Image' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('About $0.05 a picture.')).toBeInTheDocument();
    fireEvent.click(within(engine).getByRole('radio', { name: 'Off' }));
    expect(onChange).toHaveBeenCalledWith({ pictureEngine: 'off' });
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(onChange).toHaveBeenCalledWith({ pictureQuality: 'high' });
  });

  it('says when the OpenAI key is missing and links to it', async () => {
    const onOpenKeys = vi.fn();
    renderWithProviders(
      <PictureSettingsFields data={settings()} onChange={vi.fn()} onOpenKeys={onOpenKeys} />,
      {
        bridge: {
          'studioAudio.engines': async () => [{ id: 'openai', problem: 'Add an OpenAI key.' }],
        },
      },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add the key' }));
    expect(onOpenKeys).toHaveBeenCalled();
  });
});
