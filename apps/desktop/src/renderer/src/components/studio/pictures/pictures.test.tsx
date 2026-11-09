import type { PicturesView as PicturesViewData, StudioDocument } from '@runova/studio';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { PictureSettingsFields } from '../settings/PictureSettingsFields';
import { settings, withScenes } from '../testing/fixtures';
import { PicturesView } from './PicturesView';
import { StepBar } from './StepBar';
import { appView, picture, picturesView as view } from './testing/pictureFixtures';
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

function Harness(props: {
  document: StudioDocument;
  onPlan?: () => Promise<boolean>;
  onOpenSettings?: (tab: 'agents' | 'ai') => void;
  busy?: boolean;
  planning?: boolean;
}) {
  const pictures = usePictures('v1');
  return (
    <PicturesView
      videoId="v1"
      document={props.document}
      apply={vi.fn(async () => true)}
      pictures={pictures}
      busy={props.busy ?? false}
      planning={props.planning ?? false}
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

  it('cancels a capture going on', async () => {
    const { bridge } = renderView(
      planned(),
      view({ job: { running: true, done: 0, total: 2, current: null, failed: 0 } }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Capturing 1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(bridge.$fn('studioPictures.cancelCapture')).toHaveBeenCalledWith('v1'),
    );
  });

  it('says the app is starting before the first capture', async () => {
    renderView(
      planned(),
      view({
        job: { running: true, done: 0, total: 2, current: null, failed: 0 },
        app: appView({ status: 'starting' }),
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Starting the app...');
  });

  it('says how many screenshots did not work once a capture is over', async () => {
    renderView(
      planned(),
      view({ job: { running: false, done: 2, total: 2, current: null, failed: 1 } }),
    );
    expect(await screen.findByText(/1 of 2 screenshots did not work/)).toBeInTheDocument();
  });

  it('leaves screenshots out when the video has no project', async () => {
    renderView(planned(), view({ app: appView({ project: null }) }));
    expect(await screen.findByText(/This video has no project/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Capture \d/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /for screenshots/ })).toBeNull();
  });

  it('holds the plan while a run is working, and says when it is this one', async () => {
    const onPlan = vi.fn(async () => true);
    renderView(planned(), view(), { onPlan, busy: true, planning: true });
    const button = await screen.findByRole('button', { name: 'Planning...' });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    expect(onPlan).not.toHaveBeenCalled();
  });

  it('offers to plan again, and clears the box once a run has started', async () => {
    const onPlan = vi.fn(async () => true);
    renderView(planned(), view(), { onPlan });
    const box = screen.getByLabelText('Anything particular to show (optional)');
    fireEvent.change(box, { target: { value: 'The billing page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan again' }));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('keeps what was typed when the run did not start', async () => {
    const onPlan = vi.fn(async () => false);
    renderView(planned(), view(), { onPlan });
    const box = screen.getByLabelText('Anything particular to show (optional)');
    fireEvent.change(box, { target: { value: 'The billing page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan again' }));
    await waitFor(() => expect(onPlan).toHaveBeenCalled());
    expect(box).toHaveValue('The billing page');
  });

  it('sends no instruction for a blank box', async () => {
    const onPlan = vi.fn(async () => true);
    renderView(withScenes('Settings'), view(), { onPlan });
    fireEvent.click(screen.getByRole('button', { name: /Plan pictures with AI/ }));
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith(undefined));
  });

  it('links to the key when the image model has none', async () => {
    const onOpenSettings = vi.fn();
    const doc = planned();
    doc.scenario.scenes[0]!.pictures = [
      picture({ id: 'one', source: 'generate', shot: undefined }),
      picture({ id: 'two', source: 'generate', shot: undefined }),
    ];
    renderView(doc, view({ engine: 'openai', engineReady: false }), { onOpenSettings });
    expect(await screen.findByText(/GPT Image needs its API key/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add the key' }));
    expect(onOpenSettings).toHaveBeenCalledWith('ai');
  });

  it('counts several AI pictures left for the user, and names no model it does not have', async () => {
    const doc = planned();
    doc.scenario.scenes[0]!.pictures = [
      picture({ id: 'one', source: 'generate', shot: undefined }),
      picture({ id: 'two', source: 'generate', shot: undefined }),
    ];
    renderView(doc, view({ engine: 'off', engineReady: false, engineLabel: null }));
    expect(await screen.findByText(/2 AI pictures are left for you/)).toBeInTheDocument();
  });

  it('calls a model with no name the image model', async () => {
    renderView(planned(), view({ engine: 'openai', engineReady: false, engineLabel: null }));
    expect(await screen.findByText(/The image model needs its API key/)).toBeInTheDocument();
  });

  it('marks the count as done when every picture is ready, and stops offering PICTURES.md', async () => {
    const doc = withScenes('Settings');
    doc.scenario.scenes[0]!.pictures = [
      picture({ id: 'done', status: 'ready', mediaHash: 'a'.repeat(64) }),
    ];
    renderView(doc);
    // Once for the whole video and once for its only scene.
    expect(await screen.findAllByText('1 of 1 ready')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Write PICTURES.md/ })).toBeNull();
  });

  it('words a single capture as one', async () => {
    const doc = withScenes('Settings');
    doc.scenario.scenes[0]!.pictures = [
      picture({ id: 'page' }),
      picture({
        id: 'win',
        shot: { target: 'window', instructions: 'Open Preferences' },
      }),
    ];
    renderView(doc);
    expect(await screen.findByRole('button', { name: /Capture 1 screenshot$/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Capture 1 app window$/ })).toBeDefined();
  });

  it('walks through the app windows still to take', async () => {
    const doc = withScenes('Settings');
    doc.scenario.scenes[0]!.pictures = [
      picture({ id: 'one', shot: { target: 'window', instructions: 'Open Preferences' } }),
      picture({ id: 'two', shot: { target: 'window', instructions: 'Open About' } }),
      picture({
        id: 'done',
        status: 'ready',
        mediaHash: 'a'.repeat(64),
        shot: { target: 'window', instructions: 'Open Help' },
      }),
    ];
    renderView(doc);
    fireEvent.click(await screen.findByRole('button', { name: /Capture 2 app windows/ }));
    expect(
      await screen.findByRole('heading', { name: 'Capture the app window (1 of 2)' }),
    ).toBeDefined();
  });

  it('takes one window from its own picture', async () => {
    const doc = withScenes('Settings');
    doc.scenario.scenes[0]!.pictures = [
      picture({ id: 'one', shot: { target: 'window', instructions: 'Open Preferences' } }),
    ];
    renderView(doc);
    await screen.findByRole('button', { name: /Capture 1 app window/ });
    fireEvent.click(screen.getByRole('button', { name: /^Picture scene-01-one.png/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Capture the window' }));
    expect(await screen.findByRole('heading', { name: 'Capture the app window' })).toBeDefined();
  });

  it('writes PICTURES.md, opens the folder and checks it', async () => {
    const { bridge } = renderView(planned(), view(), {});
    fireEvent.click(await screen.findByRole('button', { name: /Write PICTURES.md/ }));
    await waitFor(() =>
      expect(bridge.$fn('studioPictures.writeMarkdown')).toHaveBeenCalledWith('v1'),
    );
    fireEvent.click(screen.getByRole('button', { name: /Pictures folder/ }));
    await waitFor(() => expect(bridge.$fn('studioPictures.openFolder')).toHaveBeenCalledWith('v1'));
    fireEvent.click(screen.getByRole('button', { name: /Check the folder/ }));
    await waitFor(() =>
      expect(bridge.$fn('studioPictures.checkFolder')).toHaveBeenCalledWith('v1'),
    );
  });

  it('says a scene has only drawn graphics, and names an untitled one', async () => {
    const doc = withScenes('', 'Done');
    doc.scenario.scenes[1]!.pictures = [picture({ id: 'one' })];
    renderView(doc);
    expect(await screen.findByText('Untitled scene')).toBeInTheDocument();
    expect(screen.getByText('No pictures, drawn graphics only')).toBeInTheDocument();
  });

  it('shows which AI plans the pictures', async () => {
    renderView(planned());
    await screen.findByRole('button', { name: /Write PICTURES.md/ });
    const form = screen.getByLabelText('Anything particular to show (optional)').closest('form');
    const picker = within(form as HTMLFormElement).getAllByRole('button')[0] as HTMLElement;
    fireEvent.click(picker);
    expect(await screen.findByText('Which AI plans the pictures')).toBeInTheDocument();
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
