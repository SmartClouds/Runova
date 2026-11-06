import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Studio's Pictures step (E58) in the built app: a scripted Claude Code plans a screenshot of the
 * project's settings page, Studio starts the project's own run command (a small dev server that
 * prints its address the way vite does), captures the page for real in its offscreen window and
 * puts it on the scene, and the scene animated after that carries the picture in its files.
 */

const FAKE_CLAUDE = join(__dirname, 'fixtures', 'fakeStudioClaude.cjs');
const APP = join(__dirname, 'fixtures', 'picturesApp.cjs');

const opened: LaunchedApp[] = [];

test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

type Api = {
  runova: {
    studio: {
      updateSettings(p: unknown): Promise<unknown>;
      create(input: unknown): Promise<{ id: string }>;
    };
    studioScenes: {
      code(videoId: string, sceneId: string): Promise<{ files: { path: string }[] }>;
    };
    studioMedia: { list(videoId: string): Promise<{ hash: string; width: number | null }[]> };
    projects: { create(input: unknown): Promise<{ id: string }> };
  };
};

test('plans a screenshot, starts the project, captures the page and animates the scene with it', async () => {
  test.setTimeout(240_000);
  const launched = await launchApp({ claudeScript: FAKE_CLAUDE });
  opened.push(launched);
  const { page } = launched;

  const videoId = await page.evaluate(
    async ({ defaultRoot, folderPath, command }) => {
      const api = (window as unknown as Api).runova;
      await api.studio.updateSettings({ defaultRoot });
      const project = await api.projects.create({
        name: 'Shop',
        folderPath,
        description: '',
        tags: [],
        agentType: 'claude-code',
        notes: '',
        runCommands: [{ id: 'dev', label: 'dev', command }],
      });
      const video = await api.studio.create({
        title: 'Shop tour',
        projectId: project.id,
        language: 'fa',
        aspect: '16:9',
      });
      return video.id;
    },
    {
      defaultRoot: join(launched.root, 'Videos', 'Runova Studio'),
      folderPath: launched.projectDir,
      command: `node "${APP}"`,
    },
  );

  await page.evaluate((id) => {
    window.location.hash = `#/studio/${id}`;
  }, videoId);

  // The scenario first: the brief in the Scenario view, once the editor has the video.
  await expect(page.getByRole('navigation', { name: 'Steps of the video' })).toBeVisible({
    timeout: 30_000,
  });
  // The brief card starts again from the saved brief once the AI runs have loaded, so the CLI
  // is picked first and the brief typed last.
  await page.getByRole('combobox', { name: 'CLI' }).first().click();
  await page
    .getByRole('option', { name: /Claude Code/ })
    .first()
    .click();
  await page.getByRole('combobox', { name: 'Model' }).first().click();
  await page.getByRole('option', { name: /Opus/ }).first().click();
  await page.getByLabel('What is the video about?').fill('یک ویدیوی کوتاه درباره‌ی فروشگاه');
  await page.getByRole('button', { name: 'Write scenario' }).click();
  await expect(
    page.getByRole('region', { name: 'Scene 1' }).getByLabel('Scene 1 title'),
  ).toHaveValue('قطره', { timeout: 60_000 });

  // The step bar leads to Pictures; planning reads the project and plans two pictures.
  await page
    .getByRole('navigation', { name: 'Steps of the video' })
    .getByRole('button', {
      name: /^Pictures: Not planned yet/,
    })
    .click();
  await page.getByRole('button', { name: /Plan pictures with AI/ }).click();
  const shot = page.getByRole('button', { name: /Picture scene-01-settings\.png: To do/ });
  await expect(shot).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole('button', { name: /Picture scene-02-team\.png: To do/ }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'The Shop app for screenshots' })).toBeVisible();

  // Capturing starts the app with its run command and takes the page.
  await page.getByRole('button', { name: /Capture 1 screenshot/ }).click();
  await expect(
    page.getByRole('button', { name: /Picture scene-01-settings\.png: Ready/ }),
  ).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('region', { name: 'The Shop app for screenshots' })).toContainText(
    /Running at http:\/\/localhost:\d+/,
  );

  const media = await page.evaluate(
    (id) => (window as unknown as Api).runova.studioMedia.list(id),
    videoId,
  );
  // 1440 CSS pixels wide at 2x.
  expect(media.map((m) => m.width)).toEqual([2880]);

  // The scene animated now has the screenshot among its files.
  await page.getByRole('radio', { name: 'Scenario' }).click();
  await page.getByRole('button', { name: 'Animate scene 1 with AI' }).click();
  const sceneId = (
    (await page.getByRole('region', { name: 'Scene 1' }).getAttribute('id')) ?? ''
  ).replace(/^scene-/, '');
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ id, scene }) =>
            (await (window as unknown as Api).runova.studioScenes.code(id, scene)).files.map(
              (f) => f.path,
            ),
          { id: videoId, scene: sceneId },
        ),
      { timeout: 90_000 },
    )
    .toContain('pictures/scene-01-settings.png');
});
