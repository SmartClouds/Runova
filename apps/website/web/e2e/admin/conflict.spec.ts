import type { APIRequestContext, Page } from '@playwright/test';
import { apiCall, expect, test, uniqueTitle } from './fixtures';

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const KINDS = [
  {
    kind: 'news item',
    adminPath: '/admin/news',
    create: (owner: APIRequestContext, title: string) =>
      apiCall(owner, 'POST', '/news', {
        slug: slugOf(title),
        title,
        summary: 'A draft two people open at once.',
        bodyMarkdown: 'First draft.',
        category: 'release',
        severity: 'info',
        technologies: [],
        cveIds: [],
        cvssScore: null,
        sourceLinks: [],
        tags: [],
        status: 'draft',
        publishedAt: null,
      }),
  },
  {
    kind: 'post',
    adminPath: '/admin/blog',
    create: (owner: APIRequestContext, title: string) =>
      apiCall(owner, 'POST', '/posts', {
        slug: slugOf(title),
        title,
        excerpt: 'A draft two people open at once.',
        bodyMarkdown: 'First draft.',
        tags: [],
        status: 'draft',
        publishedAt: null,
      }),
  },
];

async function openEditor(page: Page, url: string, title: string) {
  await page.goto(url);
  await expect(page.getByLabel('Title')).toHaveValue(title);
}

for (const { kind, adminPath, create } of KINDS) {
  test.describe(`a ${kind} saved in another tab`, () => {
    let url = '';
    let title = '';

    test.beforeEach(async ({ owner }) => {
      title = uniqueTitle(`Conflict ${kind}`);
      const created = await create(owner, title);
      url = `${adminPath}/${(await created.json()).id}`;
    });

    test('opens the conflict dialog, and loading theirs shows their edit', async ({
      page,
      context,
    }) => {
      const theirs = await context.newPage();
      await openEditor(page, url, title);
      await openEditor(theirs, url, title);

      await theirs.getByLabel('Title').fill(`${title} by them`);
      await theirs.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(theirs.getByRole('status')).toHaveText('Saved.');

      await page.getByLabel('Title').fill(`${title} by me`);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Someone else saved this item' });
      await expect(dialog).toBeVisible();

      await dialog.getByRole('button', { name: 'Load their version' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByLabel('Title')).toHaveValue(`${title} by them`);
      await expect(page.getByRole('status')).toHaveText(
        'Loaded the newer version. Your changes were not saved.',
      );

      // Their version is the one now on the server, and a reload agrees.
      await page.reload();
      await expect(page.getByLabel('Title')).toHaveValue(`${title} by them`);
    });

    test('cancel keeps my edit unsaved, and saving mine over theirs wins', async ({
      page,
      context,
    }) => {
      const theirs = await context.newPage();
      await openEditor(page, url, title);
      await openEditor(theirs, url, title);

      await theirs.getByLabel('Title').fill(`${title} by them`);
      await theirs.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(theirs.getByRole('status')).toHaveText('Saved.');

      await page.getByLabel('Title').fill(`${title} by me`);
      const save = page.getByRole('button', { name: 'Save', exact: true });
      await save.click();
      const dialog = page.getByRole('alertdialog', { name: 'Someone else saved this item' });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(save).toBeFocused();
      await expect(page.getByLabel('Title')).toHaveValue(`${title} by me`);

      await save.click();
      await dialog.getByRole('button', { name: 'Save mine over theirs' }).click();
      await expect(page.getByRole('status')).toHaveText('Saved.');

      await theirs.reload();
      await expect(theirs.getByLabel('Title')).toHaveValue(`${title} by me`);
    });
  });
}
