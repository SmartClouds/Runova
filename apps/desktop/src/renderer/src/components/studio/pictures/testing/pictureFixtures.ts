import type { PicturesView, ScenePicture } from '@runova/studio';
import { vi } from 'vitest';
import type { PicturesState } from '../usePictures';

/** Builders for the Pictures step's tests, so each test spells out only what it is about. */

export function picture(over: Partial<ScenePicture> & Pick<ScenePicture, 'id'>): ScenePicture {
  return {
    purpose: 'The settings page, pointing at Save.',
    source: 'screenshot',
    status: 'planned',
    shot: { target: 'route', path: '/settings', viewport: 'desktop' },
    fileName: `scene-01-${over.id}.png`,
    mediaHash: null,
    genJobId: null,
    error: null,
    ...over,
  };
}

export function appView(over: Partial<PicturesView['app']> = {}): PicturesView['app'] {
  return {
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
    ...over,
  };
}

export function picturesView(over: Partial<PicturesView> = {}): PicturesView {
  return {
    app: appView(),
    job: null,
    engine: 'openai',
    engineReady: true,
    engineLabel: 'GPT Image',
    folder: 'C:\\videos\\shop\\pictures',
    ...over,
  };
}

/** The Pictures state with nothing going on, for components that only call into it. */
export function fakePictures(over: Partial<PicturesState> = {}): PicturesState {
  const action = () => vi.fn(async () => undefined);
  return {
    view: undefined,
    loading: false,
    pending: null,
    setApp: action(),
    startApp: action(),
    stopApp: action(),
    signIn: action(),
    capture: action(),
    cancelCapture: action(),
    generate: action(),
    writeMarkdown: action(),
    checkFolder: action(),
    openFolder: action(),
    pickFile: action(),
    setFile: action(),
    captureWindow: action(),
    ...over,
  } as PicturesState;
}
