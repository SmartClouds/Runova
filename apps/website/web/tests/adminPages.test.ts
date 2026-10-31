import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import AdminLayout from '../src/layouts/AdminLayout.astro';
import type { AdminUser } from '../src/lib/admin/guard';
import ApiClientPage from '../src/pages/admin/api-clients/[id].astro';
import ApiClientsPage from '../src/pages/admin/api-clients/index.astro';
import NewApiClientPage from '../src/pages/admin/api-clients/new.astro';
import ForbiddenPage from '../src/pages/admin/forbidden.astro';
import OverviewPage from '../src/pages/admin/index.astro';
import SetPasswordPage from '../src/pages/admin/set-password.astro';
import UserPage from '../src/pages/admin/users/[id].astro';
import UsersPage from '../src/pages/admin/users/index.astro';
import NewUserPage from '../src/pages/admin/users/new.astro';

const EDITOR: AdminUser = { id: 2, email: 'e@runovahq.com', displayName: 'Eda', roles: ['Editor'] };
const ADMIN: AdminUser = { id: 1, email: 'a@runovahq.com', displayName: 'Ada', roles: ['Admin'] };

let container: AstroContainer;

beforeAll(async () => {
  const renderers = await loadRenderers([reactRenderer()]);
  container = await AstroContainer.create({
    renderers,
    astroConfig: { site: 'https://runovahq.com' },
  });
});

type Page = Parameters<AstroContainer['renderToResponse']>[0];

const render = (page: Page, path: string, user?: AdminUser, params?: Record<string, string>) =>
  container.renderToResponse(page, {
    request: new Request(`https://runovahq.com${path}`),
    locals: { adminUser: user },
    params,
    slots: { default: '<p>Body</p>' },
    props: { title: 'Test' },
  });

const navLinks = (html: string) => {
  const nav = html.match(/<nav aria-label="Admin"[\s\S]*?<\/nav>/)?.[0] ?? '';
  return [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
};

describe('the admin menu', () => {
  it('gives an Editor only the news and the blog', async () => {
    const html = await (await render(AdminLayout, '/admin', EDITOR)).text();
    expect(navLinks(html)).toEqual(['/admin/news', '/admin/blog']);
  });

  it('gives an Admin the API clients, the users and the jobs dashboard too', async () => {
    const html = await (await render(AdminLayout, '/admin', ADMIN)).text();
    expect(navLinks(html)).toEqual([
      '/admin/news',
      '/admin/blog',
      '/admin/api-clients',
      '/admin/users',
      '/hangfire',
    ]);
  });

  it('marks the section of the current page', async () => {
    const html = await (await render(AdminLayout, '/admin/users/4', ADMIN)).text();
    expect(html).toMatch(/<a href="\/admin\/users" aria-current="page"/);
  });

  it('marks nothing on the overview', async () => {
    const html = await (await render(AdminLayout, '/admin', ADMIN)).text();
    expect(html).not.toContain('aria-current');
  });
});

describe('the overview', () => {
  it('shows an Editor no cards for the Admin pages', async () => {
    const html = await (await render(OverviewPage, '/admin', EDITOR)).text();
    const main = html.slice(html.indexOf('<main'));
    expect(main).not.toContain('/admin/api-clients');
    expect(main).not.toContain('/admin/users');
    expect(main).not.toContain('/hangfire');
  });

  it('shows an Admin a card for each Admin page', async () => {
    const html = await (await render(OverviewPage, '/admin', ADMIN)).text();
    const main = html.slice(html.indexOf('<main'));
    expect(main).toContain('href="/admin/api-clients"');
    expect(main).toContain('href="/admin/users"');
    expect(main).toContain('href="/hangfire"');
  });
});

describe('the admin pages', () => {
  it.each([
    ['/admin/api-clients', ApiClientsPage, 'ApiClientList'],
    ['/admin/api-clients/new', NewApiClientPage, 'ApiClientEditor'],
    ['/admin/users', UsersPage, 'UserList'],
    ['/admin/users/new', NewUserPage, 'InviteForm'],
  ] as const)('%s renders its island', async (path, page, island) => {
    const response = await render(page, path, ADMIN);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(island);
  });

  it.each([
    ['/admin/api-clients/7', ApiClientPage, 'ApiClientEditor'],
    ['/admin/users/7', UserPage, 'UserEditor'],
  ] as const)('%s renders the editor for that id', async (path, page, island) => {
    const response = await render(page, path, ADMIN, { id: '7' });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(island);
    expect(html).toMatch(/props="[^"]*&quot;id&quot;:\[0,7\]/);
  });

  it.each([
    ['/admin/api-clients/x', ApiClientPage],
    ['/admin/users/0', UserPage],
  ] as const)('%s is not found', async (path, page) => {
    const response = await render(page, path, ADMIN, { id: path.split('/').at(-1) ?? '' });
    expect(response.status).toBe(404);
  });

  it('set-password renders its form without a session', async () => {
    const response = await render(SetPasswordPage, '/admin/set-password');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('SetPasswordForm');
    expect(navLinks(html)).toEqual([]);
  });

  it('forbidden answers 403 and says the page is for Admins', async () => {
    const response = await render(ForbiddenPage, '/admin/forbidden', EDITOR);
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toMatch(/<h1[^>]*>[^<]*Admins/);
    expect(navLinks(html)).toEqual(['/admin/news', '/admin/blog']);
  });
});
