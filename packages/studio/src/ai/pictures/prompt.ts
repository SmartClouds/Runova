import { z } from 'zod';
import { DESIGN_SIZES, type StudioDocument } from '../../document/schema.js';
import { scenePictures } from '../../pictures/pictures.js';
import { flicksToSeconds } from '../../time/flicks.js';
import { picturesAnswerSchema } from './answer.js';

/**
 * The request for the Pictures step: given the scenario and, when the video belongs to a project,
 * read access to that project, decide what each scene should show. Studio then takes the
 * screenshots itself, sends the prompts to the image model, or lists them for the user.
 */

export interface PicturesProject {
  name: string;
  /** The folder the CLI runs in, which it may read but not change. */
  folderPath: string;
  runCommands: { id: string; label: string; command: string }[];
}

export interface PicturesRequestInput {
  document: StudioDocument;
  project: PicturesProject | null;
  /** The image model pictures can be made with, or null when the user makes them. */
  imageModel: string | null;
  /** What the user asked for, when they asked for something particular. */
  instruction?: string;
}

function quoted(text: string): string {
  const fence = text.includes('~~~~') ? '~~~~~~' : '~~~~';
  return `${fence}text\n${text.trim()}\n${fence}`;
}

export function buildPicturesRequest(input: PicturesRequestInput): string {
  const { document: doc, project } = input;
  const size = DESIGN_SIZES[doc.renderSettings.aspect];
  const scenes = doc.scenario.scenes.map((scene, index) => ({
    sceneId: scene.id,
    number: index + 1,
    title: scene.title,
    seconds: Math.round(flicksToSeconds(scene.targetDuration) * 10) / 10,
    narration: scene.narration,
    onScreenText: scene.onScreenText,
    visualBrief: scene.visualBrief,
    readyPictures: scenePictures(scene)
      .filter((p) => p.status === 'ready')
      .map((p) => p.purpose),
  }));
  const sources = [
    project
      ? '- "screenshot": a real screen of the project, which Studio captures itself. Prefer this for anything the product really shows: its pages, dialogs, settings, results.'
      : '',
    input.imageModel
      ? `- "generate": a picture made by ${input.imageModel} from your prompt. Use it only for what no screen of the product shows: a concept, a scene from the user's world, a background. Write the prompt in English, describe the picture fully (subject, setting, composition, light, style) and say it has no text in it.`
      : '',
    `- "file": a picture the user makes or finds themselves. ${input.imageModel ? 'Use it for what neither a screen nor an image model can give, such as a photo of the real team or a logo.' : 'Use it for everything that is not a screen of the product, with a full prompt the user can paste into an image tool.'}`,
  ].filter(Boolean);

  const sections = [
    '# Plan the pictures of a video',
    'You plan the pictures for the scenes of a short animated video. A motion designer will later animate each scene and build its motion around the pictures you choose: framed in a browser or device frame, zoomed, panned and highlighted. Pick only pictures that make a scene clearer; many scenes need none.',
    input.instruction ? `## What the user asks\n\n${quoted(input.instruction)}` : '',
    '## The video',
    [
      `- Title: ${doc.title}`,
      `- Logline: ${doc.scenario.logline || '(none)'}`,
      `- Format: ${doc.renderSettings.aspect}, designed at ${size.width}x${size.height}.`,
    ].join('\n'),
    project
      ? [
          `## The project: ${project.name}`,
          `The video is about this project. You are running in its folder, ${project.folderPath}. Read its code (routes, pages, screens, README) to find the real screens to show. Only read: do not change, create or delete any file, and do not run anything. Studio starts the app and takes the screenshots.`,
          project.runCommands.length > 0
            ? `How the project is started, as set up in Runova:\n${project.runCommands.map((c) => `- id "${c.id}"${c.label ? ` (${c.label})` : ''}: \`${c.command}\``).join('\n')}`
            : 'No run command is set up in Runova. Work out from the project how it starts and which address it serves.',
        ].join('\n\n')
      : '## The project\nThe video belongs to no project, so there is nothing to take screenshots of.',
    '## The scenes',
    `\`\`\`json\n${JSON.stringify(scenes, null, 1)}\n\`\`\``,
    '## Where pictures come from',
    sources.join('\n'),
    '## Rules',
    [
      '- At most 3 pictures for a scene, and only where they help. Do not repeat a picture a scene already has (its "readyPictures").',
      '- "purpose" says what the picture shows and what the animator should point at, in one or two sentences. Write it in English.',
      '- "label" is two or three English words for the file name, like "settings page".',
      project
        ? '- For a web app, a screenshot is a "route" shot: the path after the app address (like "/settings"), an optional CSS selector to wait for, and optional steps (click, type, scroll, wait) that bring the page to the right state. Use selectors that really exist in the code. Use "desktop" unless the product is a phone app.'
        : '',
      project
        ? '- For a desktop or phone app that has no address, a screenshot is a "window" shot with plain instructions for the user, such as "Open Settings, then the AI tab".'
        : '',
      project
        ? '- In "app", say what kind of app it is, which run command starts it (its id), and the address it serves, like http://localhost:5173, when you can tell from the code.'
        : '- In "app", give kind "none".',
      '- No real people, no logos you were not given and no copyrighted characters in prompts.',
    ]
      .filter(Boolean)
      .join('\n'),
    '## How to answer',
    'Answer with one JSON object and nothing else: no explanation, no markdown around it. List every scene that should get pictures, by its "sceneId". It must match this JSON Schema:',
    `\`\`\`json\n${JSON.stringify(z.toJSONSchema(picturesAnswerSchema, { io: 'input' }), null, 2)}\n\`\`\``,
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

/** What a CLI that takes its prompt as an argument is told: where the request is. */
export function picturesPointerPrompt(requestPath: string): string {
  return `Read the file ${requestPath} and do exactly what it asks. Do not create or change any files. Reply with the JSON answer only.`;
}
