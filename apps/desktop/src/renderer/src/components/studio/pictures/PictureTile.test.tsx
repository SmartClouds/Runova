import { type ScenePicture, type Shot, updatePictureOp } from '@runova/studio';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { withScenes } from '../testing/fixtures';
import { PictureTile, type PictureTileProps } from './PictureTile';
import { fakePictures, picture, picturesView } from './testing/pictureFixtures';

const HASH = 'a'.repeat(64);

function renderTile(shown: ScenePicture, over: Partial<PictureTileProps> = {}) {
  const doc = withScenes('Settings');
  const scene = doc.scenario.scenes[0]!;
  scene.pictures = [shown];
  const apply = vi.fn(async () => true);
  const pictures = over.pictures ?? fakePictures();
  const onCaptureWindow = vi.fn();
  renderWithProviders(
    <PictureTile
      videoId="v1"
      scene={scene}
      picture={shown}
      aspect="16 / 9"
      canCapture
      imageModel="GPT Image"
      capturing={false}
      pictures={pictures}
      apply={apply}
      onCaptureWindow={onCaptureWindow}
      {...over}
    />,
  );
  /** The edit a change to this picture should have sent. */
  const expectChange = (patch: Partial<Omit<ScenePicture, 'id'>>, label: string) =>
    expect(apply).toHaveBeenLastCalledWith([updatePictureOp(scene, shown.id, patch)], label);
  return { apply, pictures, onCaptureWindow, scene, expectChange };
}

/** Clicks the tile, which opens everything about the picture. */
function open(shown: ScenePicture): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Picture ${shown.fileName}`) }));
}

function edit(label: string | RegExp, value: string): void {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

function choose(group: string, option: string): void {
  fireEvent.click(
    within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }),
  );
}

const windowShot: Shot = { target: 'window', instructions: 'Open Preferences' };

describe('the tile', () => {
  it.each([
    ['To do', {}, false],
    ['Ready', { status: 'ready', mediaHash: HASH }, false],
    ['Failed', { status: 'failed', error: 'It broke.' }, false],
    ['Making', { genJobId: 'g1' }, false],
    ['Capturing', {}, true],
  ] as const)('says %s', (label, over, capturing) => {
    const shown = picture({ id: 'a', ...over });
    renderTile(shown, { capturing });
    expect(
      screen.getByRole('button', { name: new RegExp(`Picture scene-01-a.png: ${label}\\.`) }),
    ).toBeInTheDocument();
  });

  it('shows the picture once it is ready', () => {
    renderTile(picture({ id: 'a', status: 'ready', mediaHash: HASH }));
    expect(document.querySelector('img')?.getAttribute('src')).toContain(HASH);
  });

  it('shows what the picture will be until then', () => {
    const shown = picture({ id: 'a' });
    renderTile(shown);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(shown.purpose)).toBeInTheDocument();
  });

  it('falls back to what it needs when it has no description', () => {
    renderTile(picture({ id: 'a', purpose: '' }));
    expect(screen.getAllByText('/settings')).toHaveLength(2);
  });

  it.each([
    ['the page', picture({ id: 'a' }), 'Screenshot', '/settings', 'GPT Image'],
    [
      'the site root',
      picture({ id: 'a', shot: { target: 'route', path: '', viewport: 'desktop' } }),
      'Screenshot',
      '/',
      'GPT Image',
    ],
    ['a window', picture({ id: 'a', shot: windowShot }), 'Screenshot', 'App window', 'GPT Image'],
    [
      'the model',
      picture({ id: 'a', source: 'generate', shot: undefined }),
      'GPT Image',
      'scene-01-a.png',
      'GPT Image',
    ],
    [
      'no model',
      picture({ id: 'a', source: 'generate', shot: undefined }),
      'AI picture',
      'scene-01-a.png',
      null,
    ],
    [
      'a file',
      picture({ id: 'a', source: 'file', shot: undefined }),
      'Your file',
      'scene-01-a.png',
      'GPT Image',
    ],
  ])('captions %s', (_name, shown, source, what, imageModel) => {
    renderTile(shown, { imageModel });
    expect(screen.getByText(source)).toBeInTheDocument();
    expect(screen.getByText(what)).toBeInTheDocument();
  });
});

describe('editing a picture', () => {
  it('saves a new description, and leaves an empty or unchanged one', () => {
    const shown = picture({ id: 'a' });
    const { apply, expectChange } = renderTile(shown);
    open(shown);
    edit('What it shows', '   ');
    edit('What it shows', shown.purpose);
    expect(apply).not.toHaveBeenCalled();
    edit('What it shows', '  The billing page  ');
    expectChange({ purpose: 'The billing page' }, 'Described picture scene-01-a.png');
  });

  it('shows why it failed, and only when it failed', () => {
    const shown = picture({ id: 'a', status: 'failed', error: 'The page did not load: 404.' });
    renderTile(shown);
    open(shown);
    expect(screen.getByText('The page did not load: 404.')).toBeInTheDocument();
  });

  it('removes the picture', () => {
    const shown = picture({ id: 'a' });
    const { apply } = renderTile(shown);
    open(shown);
    fireEvent.click(screen.getByRole('button', { name: 'Remove picture scene-01-a.png' }));
    expect(apply).toHaveBeenCalledWith(expect.any(Array), 'Removed picture scene-01-a.png');
  });

  it('shows a ready picture large', () => {
    const shown = picture({ id: 'a', status: 'ready', mediaHash: HASH });
    renderTile(shown);
    open(shown);
    expect(screen.getByRole('img', { name: shown.purpose })).toBeInTheDocument();
  });
});

describe('where a picture comes from', () => {
  const blank = { status: 'planned', mediaHash: null, error: null, genJobId: null } as const;

  it('does nothing when the choice has not changed', () => {
    const shown = picture({ id: 'a' });
    const { apply } = renderTile(shown);
    open(shown);
    choose('Where the picture comes from', 'Screenshot');
    expect(apply).not.toHaveBeenCalled();
  });

  it('starts an AI picture from what the screenshot was meant to show', () => {
    const shown = picture({ id: 'a' });
    const { expectChange } = renderTile(shown);
    open(shown);
    choose('Where the picture comes from', 'GPT Image');
    expectChange(
      { source: 'generate', ...blank, prompt: shown.purpose },
      'Picture scene-01-a.png is now gpt image',
    );
  });

  it('keeps a prompt the picture already has', () => {
    const shown = picture({ id: 'a', source: 'generate', shot: undefined, prompt: 'A calm desk' });
    const { expectChange } = renderTile(shown);
    open(shown);
    choose('Where the picture comes from', 'Your file');
    expectChange({ source: 'file', ...blank }, 'Picture scene-01-a.png is now your file');
  });

  it('gives a new screenshot the home page of the app', () => {
    const shown = picture({ id: 'a', source: 'file', shot: undefined, prompt: 'A calm desk' });
    const { expectChange } = renderTile(shown);
    open(shown);
    choose('Where the picture comes from', 'Screenshot');
    expectChange(
      {
        source: 'screenshot',
        ...blank,
        shot: { target: 'route', path: '/', viewport: 'desktop' },
      },
      'Picture scene-01-a.png is now screenshot',
    );
  });

  it('keeps the shot a screenshot had before', () => {
    const shown = picture({ id: 'a', source: 'file', prompt: 'A calm desk' });
    const { expectChange } = renderTile(shown);
    open(shown);
    choose('Where the picture comes from', 'Screenshot');
    expectChange({ source: 'screenshot', ...blank }, 'Picture scene-01-a.png is now screenshot');
  });

  it('explains why a video with no project cannot take screenshots', () => {
    const shown = picture({ id: 'a', source: 'file', shot: undefined });
    renderTile(shown, { canCapture: false, imageModel: null });
    open(shown);
    const radio = screen.getByRole('radio', { name: 'Screenshot' });
    expect(radio).toBeDisabled();
    expect(radio).toHaveAttribute('title', 'Link the video to a project to take screenshots.');
    expect(screen.getByRole('radio', { name: 'AI picture' })).toBeEnabled();
  });
});

describe('a page of the app', () => {
  const route: Extract<Shot, { target: 'route' }> = {
    target: 'route',
    path: '/settings',
    viewport: 'desktop',
  };

  it('changes the page', () => {
    const shown = picture({ id: 'a', shot: route });
    const { apply, expectChange } = renderTile(shown);
    open(shown);
    edit('Page', '/settings');
    expect(apply).not.toHaveBeenCalled();
    edit('Page', ' /billing ');
    expectChange({ shot: { ...route, path: '/billing' } }, 'Changed the page of scene-01-a.png');
  });

  it('changes the screen size', () => {
    const shown = picture({ id: 'a', shot: route });
    const { expectChange } = renderTile(shown);
    open(shown);
    choose('Screen size', 'Phone');
    expectChange(
      { shot: { ...route, viewport: 'mobile' } },
      'Changed the screen size of scene-01-a.png',
    );
  });

  it('changes what it waits for, and clears it', () => {
    const shown = picture({ id: 'a', shot: { ...route, waitFor: '#form' } });
    const { apply, expectChange } = renderTile(shown);
    open(shown);
    edit('Wait for (optional)', '#form');
    expect(apply).not.toHaveBeenCalled();
    edit('Wait for (optional)', '   ');
    expectChange(
      { shot: { ...route, waitFor: undefined } },
      'Changed what scene-01-a.png waits for',
    );
  });

  it('starts with no wait, and picks one up', () => {
    const shown = picture({ id: 'a', shot: route });
    const { expectChange } = renderTile(shown);
    open(shown);
    edit('Wait for (optional)', '#ready');
    expectChange(
      { shot: { ...route, waitFor: '#ready' } },
      'Changed what scene-01-a.png waits for',
    );
  });

  it('sets a theme, and goes back to the app choosing its own', () => {
    const dark = picture({ id: 'a', shot: { ...route, theme: 'dark' } });
    const { expectChange } = renderTile(dark);
    open(dark);
    choose('Theme', 'Auto');
    expectChange({ shot: { ...route, theme: undefined } }, 'Changed the theme of scene-01-a.png');
    choose('Theme', 'Light');
    expectChange({ shot: { ...route, theme: 'light' } }, 'Changed the theme of scene-01-a.png');
  });

  it('lists the steps before the picture, and clears them', () => {
    const steps = [
      { do: 'wait', ms: 500 },
      { do: 'scroll', y: 200 },
      { do: 'scroll', selector: '#list', y: 40 },
      { do: 'click', selector: '#save' },
      { do: 'type', selector: '#name', text: 'Ada' },
    ] as Extract<Shot, { target: 'route' }>['steps'];
    const shown = picture({ id: 'a', shot: { ...route, steps } });
    const { expectChange } = renderTile(shown);
    open(shown);
    for (const line of [
      'wait 500 ms',
      'scroll page to 200',
      'scroll #list to 40',
      'click #save',
      'type #name "Ada"',
    ]) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Clear the steps' }));
    expectChange({ shot: { ...route, steps: [] } }, 'Cleared the steps of scene-01-a.png');
  });

  it('moves to capturing a window, starting from what it shows', () => {
    const shown = picture({ id: 'a', shot: route });
    const { expectChange } = renderTile(shown);
    open(shown);
    choose('What to capture', 'An app window');
    expectChange(
      { shot: { target: 'window', instructions: shown.purpose } },
      'Picture scene-01-a.png captures a window',
    );
  });

  it('captures this picture, and can capture it again', () => {
    const shown = picture({ id: 'a', status: 'ready', mediaHash: HASH, shot: route });
    const { pictures } = renderTile(shown);
    open(shown);
    fireEvent.click(screen.getByRole('button', { name: 'Capture again' }));
    expect(pictures.capture).toHaveBeenCalledWith(['a']);
  });

  it('holds the button while this picture or another capture is going', () => {
    const shown = picture({ id: 'a', shot: route });
    renderTile(shown, { capturing: true });
    open(shown);
    expect(screen.getByRole('button', { name: 'Capturing...' })).toBeDisabled();
  });

  it('holds the button while a capture of the whole video runs', () => {
    const shown = picture({ id: 'a', shot: route });
    const pictures = fakePictures({
      view: picturesView({
        job: { running: true, done: 0, total: 2, current: null, failed: 0 },
      }),
    });
    renderTile(shown, { pictures });
    open(shown);
    expect(screen.getByRole('button', { name: 'Capture' })).toBeDisabled();
  });
});

describe('an app window', () => {
  it('changes how to reach the screen, and leaves it when it is the same', () => {
    const shown = picture({ id: 'a', shot: windowShot });
    const { apply, expectChange } = renderTile(shown);
    open(shown);
    edit('How to get to this screen', ' Open Preferences ');
    expect(apply).not.toHaveBeenCalled();
    edit('How to get to this screen', 'Open About');
    expectChange(
      { shot: { target: 'window', instructions: 'Open About' } },
      'Changed how to reach scene-01-a.png',
    );
  });

  it('moves to a page of the app, starting at its home page', () => {
    const shown = picture({ id: 'a', shot: windowShot });
    const { expectChange } = renderTile(shown);
    open(shown);
    choose('What to capture', 'A page of the app');
    expectChange(
      { shot: { target: 'route', path: '/', viewport: 'desktop' } },
      'Picture scene-01-a.png captures a page',
    );
  });

  it('starts the guided capture', () => {
    const shown = picture({ id: 'a', shot: windowShot });
    const { onCaptureWindow } = renderTile(shown);
    open(shown);
    fireEvent.click(screen.getByRole('button', { name: 'Capture the window' }));
    expect(onCaptureWindow).toHaveBeenCalledWith(shown);
  });

  it('offers to take it again once it is ready', () => {
    const shown = picture({ id: 'a', status: 'ready', mediaHash: HASH, shot: windowShot });
    renderTile(shown);
    open(shown);
    expect(screen.getByRole('button', { name: 'Capture again' })).toBeEnabled();
  });
});

describe('an AI picture', () => {
  const made = (over: Partial<ScenePicture> = {}) =>
    picture({ id: 'a', source: 'generate', shot: undefined, prompt: 'A calm desk', ...over });

  it('changes the prompt, and leaves it when it is the same', () => {
    const shown = made();
    const { apply, expectChange } = renderTile(shown);
    open(shown);
    edit('Prompt', ' A calm desk ');
    expect(apply).not.toHaveBeenCalled();
    edit('Prompt', 'A busy desk');
    expectChange({ prompt: 'A busy desk' }, 'Changed the prompt of scene-01-a.png');
  });

  it('reads a picture with no prompt yet as empty', () => {
    const shown = made({ prompt: undefined });
    const { apply } = renderTile(shown);
    open(shown);
    edit('Prompt', '   ');
    expect(apply).not.toHaveBeenCalled();
  });

  it('makes the picture', () => {
    const shown = made();
    const { pictures } = renderTile(shown);
    open(shown);
    fireEvent.click(screen.getByRole('button', { name: 'Make with GPT Image' }));
    expect(pictures.generate).toHaveBeenCalledWith(['a']);
  });

  it('says where to turn picture making on when there is no model', () => {
    const shown = made();
    renderTile(shown, { imageModel: null });
    open(shown);
    const button = screen.getByRole('button', { name: 'Make with AI' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'Turn on picture making in Settings > Agents > Studio.',
    );
  });

  it('shows it being made, and offers to make it again after', () => {
    const making = made({ genJobId: 'g1' });
    renderTile(making);
    open(making);
    expect(screen.getByRole('button', { name: 'Making...' })).toBeDisabled();
  });

  it('offers to make a ready picture again', () => {
    const shown = made({ status: 'ready', mediaHash: HASH });
    renderTile(shown);
    open(shown);
    expect(screen.getByRole('button', { name: 'Make again' })).toBeEnabled();
    expect(screen.queryByText(/Or save it as/)).toBeNull();
  });

  it('says the file can also just be saved in the folder', () => {
    const shown = made();
    renderTile(shown);
    open(shown);
    expect(screen.getByText(/Or save it as scene-01-a.png/)).toBeInTheDocument();
  });
});

describe('a file of your own', () => {
  it('asks what to make and picks the file', () => {
    const shown = picture({ id: 'a', source: 'file', shot: undefined });
    const { pictures } = renderTile(shown);
    open(shown);
    expect(screen.getByLabelText('What to make (also in PICTURES.md)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a picture' }));
    expect(pictures.pickFile).toHaveBeenCalledWith('a');
  });

  it('holds the button while the file is being picked', () => {
    const shown = picture({ id: 'a', source: 'file', shot: undefined });
    renderTile(shown, { pictures: fakePictures({ pending: 'file-a' }) });
    open(shown);
    expect(screen.getByRole('button', { name: 'Choose a picture' })).toBeDisabled();
  });

  it('offers a file instead on any other picture', () => {
    const shown = picture({ id: 'a' });
    const { pictures } = renderTile(shown);
    open(shown);
    fireEvent.click(screen.getByRole('button', { name: 'Use a file instead' }));
    expect(pictures.pickFile).toHaveBeenCalledWith('a');
  });
});
