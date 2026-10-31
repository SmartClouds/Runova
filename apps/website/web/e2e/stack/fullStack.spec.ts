// The whole stack from apps/website/compose.yaml, as production runs it: Caddy in front of the
// site and the API on one origin, PostgreSQL behind the API. Nothing here is faked.
import { expect, request, test } from '@playwright/test';
import { apiClient, newContext, ownerSession, signedPost, unique } from './stackApi.ts';
import { STACK_HTTP_URL, STACK_URL } from './stackConfig.ts';

test('one origin serves the site, the API and the jobs dashboard', async ({ page }) => {
  const visitor = await newContext();
  try {
    const home = await visitor.get('/');
    expect(home.status()).toBe(200);
    expect(home.headers()['content-type']).toContain('text/html');
    expect(home.headers()['strict-transport-security']).toBeTruthy();

    const news = await visitor.get('/api/v1/news');
    expect(news.status()).toBe(200);
    expect(news.headers()['content-type']).toContain('application/json');

    // The API answers for /hangfire, so a visitor who is not signed in gets its 401.
    expect((await visitor.get('/hangfire', { maxRedirects: 0 })).status()).toBe(401);
  } finally {
    await visitor.dispose();
  }

  const owner = await ownerSession();
  try {
    await page.context().addCookies((await owner.storageState()).cookies);
  } finally {
    await owner.dispose();
  }
  await page.goto('/hangfire');
  await expect(page.getByRole('link', { name: /Recurring Jobs/ })).toBeVisible();
});

test('plain HTTP redirects to the same path on the HTTPS origin', async () => {
  const visitor = await request.newContext();
  try {
    const response = await visitor.get(`${STACK_HTTP_URL}/news?page=2`, { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe(`${STACK_URL}/news?page=2`);
  } finally {
    await visitor.dispose();
  }
});

test('an API client signs a news POST and the item appears on /news and in the API', async ({
  page,
}) => {
  const key = await apiClient(['news:write']);
  const id = unique();
  const slug = `stack-release-${id}`;
  const tag = `stack-${id}`;
  const title = `Stack release ${id} is out`;
  const body = JSON.stringify({
    slug,
    title,
    summary: 'A release posted by a signed API client through the compose stack.',
    bodyMarkdown: 'Posted by the full-stack spec.',
    category: 'release',
    severity: 'info',
    technologies: [],
    cveIds: [],
    cvssScore: null,
    sourceLinks: [],
    tags: [tag],
    status: 'published',
    publishedAt: null,
  });

  const client = await newContext();
  try {
    const created = await signedPost(client, key, '/news', body);
    expect(created.status(), await created.text()).toBe(201);
    expect((await created.json()).createdBy.kind).toBe('api-client');

    const listed = await client.get(`/api/v1/news?tag=${tag}`);
    expect(listed.status()).toBe(200);
    const items = (await listed.json()).items as { slug: string; title: string; url: string }[];
    expect(items.map((item) => item.slug)).toEqual([slug]);
    expect(items[0].url).toBe(`${STACK_URL}/news/${slug}`);
  } finally {
    await client.dispose();
  }

  await page.goto('/news');
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  await page.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(`${STACK_URL}/news/${slug}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
});

test('media uploaded through the API is served at /media by the proxy', async () => {
  const key = await apiClient(['posts:write']);
  // A 1 by 1 PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const boundary = `----stack${unique()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="alt"\r\n\r\nA dot\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\n` +
        'Content-Type: image/png\r\n\r\n',
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const client = await newContext();
  try {
    const uploaded = await signedPost(
      client,
      key,
      '/media',
      body,
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const { url } = await uploaded.json();
    expect(url).toMatch(new RegExp(`^${STACK_URL}/media/\\d{4}/\\d{2}/[0-9a-f]+\\.png$`));

    const file = await client.get(url);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('image/png');
    expect(file.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  } finally {
    await client.dispose();
  }
});
