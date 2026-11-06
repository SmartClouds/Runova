import { DESIGN_SIZES, type ScenePicture, type StudioDocument } from '../document/schema.js';
import { imageSizeFor, PICTURES_DIR, pendingPictures, shotViewport } from './pictures.js';

/**
 * PICTURES.md: the pictures a video still needs, written for a person who makes them by hand or
 * pastes the prompts into any image tool. Saving a file under the name given puts it in its scene.
 */
export function picturesMarkdown(doc: StudioDocument): string {
  const design = DESIGN_SIZES[doc.renderSettings.aspect];
  const pending = pendingPictures(doc);
  const lines = [
    `# Pictures for "${doc.title}"`,
    '',
    `The video is ${doc.renderSettings.aspect}, designed at ${design.width}x${design.height}.`,
    pending.length === 0
      ? 'Every picture is ready. Nothing to make.'
      : `${pending.length} ${pending.length === 1 ? 'picture is' : 'pictures are'} still needed. Save each one in this folder (\`${PICTURES_DIR}\`) under the file name given, and Studio puts it in its scene. PNG, JPG and WebP all work; the extension may differ.`,
  ];
  for (const { scene, sceneIndex, picture } of pending) {
    lines.push('', `## Scene ${sceneIndex + 1}: ${scene.title || 'Untitled scene'}`, '');
    lines.push(`- **File name:** \`${picture.fileName}\``);
    lines.push(`- **What it is for:** ${oneLine(picture.purpose) || 'not given'}`);
    lines.push(...howToMake(picture, doc));
    if (picture.status === 'failed' && picture.error) {
      lines.push(`- **Last try failed:** ${oneLine(picture.error)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function howToMake(picture: ScenePicture, doc: StudioDocument): string[] {
  const shot = picture.shot;
  if (picture.source === 'screenshot' && shot?.target === 'route') {
    const size = shotViewport(shot.viewport);
    return [
      `- **Screenshot of:** \`${shot.path || '/'}\` in the app, at ${size.width}x${size.height}${shot.theme ? `, ${shot.theme} theme` : ''}.`,
      ...(shot.steps?.length
        ? [`- **Before taking it:** ${shot.steps.map(stepText).join('; ')}.`]
        : []),
    ];
  }
  if (picture.source === 'screenshot' && shot?.target === 'window') {
    return [`- **Screenshot of the app window:** ${oneLine(shot.instructions)}`];
  }
  const size = imageSizeFor(doc.renderSettings.aspect);
  return [
    `- **Size:** ${size} (${doc.renderSettings.aspect})`,
    '- **Prompt:**',
    '',
    '```text',
    (picture.prompt || picture.purpose).trim(),
    '```',
  ];
}

function stepText(
  step: NonNullable<Extract<ScenePicture['shot'], { target: 'route' }>['steps']>[number],
) {
  switch (step.do) {
    case 'click':
      return `click \`${step.selector}\``;
    case 'type':
      return `type "${step.text}" into \`${step.selector}\``;
    case 'scroll':
      return `scroll ${step.selector ? `\`${step.selector}\`` : 'the page'} to ${step.y}px`;
    case 'wait':
      return `wait ${step.ms} ms`;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
