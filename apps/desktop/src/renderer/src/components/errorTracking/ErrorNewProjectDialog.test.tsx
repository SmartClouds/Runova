import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { connection, createdProject, DSN, project, team } from './testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { ErrorNewProjectDialog } = await import('./ErrorNewProjectDialog');

/**
 * Making a Sentry project from the Errors tab: the form asks only for what Sentry needs and fills
 * in what it can, a token that cannot create projects is stopped before it tries, and the DSN
 * comes back ready to copy with the snippet that puts it to work.
 */

const projects = [project(), project({ id: 'p2', name: 'Admin', folderPath: 'C:\\work\\admin' })];
const creator = connection({ canCreateProjects: true });

function renderDialog(
  props: Partial<React.ComponentProps<typeof ErrorNewProjectDialog>> = {},
  bridge: Record<string, unknown> = {},
) {
  const onReplaceToken = vi.fn();
  const view = renderWithProviders(
    <ErrorNewProjectDialog
      open
      onOpenChange={vi.fn()}
      connections={[creator]}
      projects={projects}
      defaultProjectId="p1"
      onReplaceToken={onReplaceToken}
      {...props}
    />,
    {
      bridge: {
        'errorTracking.teams': [team()],
        'errorTracking.createProject': async () => createdProject(),
        ...bridge,
      },
    },
  );
  return { ...view, onReplaceToken };
}

async function dialog() {
  return screen.findByRole('dialog', { name: 'New Sentry project' });
}

async function pick(user: ReturnType<typeof renderDialog>['user'], box: string, option: string) {
  const view = await dialog();
  await user.click(within(view).getByRole('combobox', { name: box }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('ErrorNewProjectDialog, the form', () => {
  it('fills in the name and team, creates the project and links it', async () => {
    const { user, bridge } = renderDialog();
    const view = await dialog();

    expect(within(view).getByLabelText('Project name')).toHaveValue('Storefront');
    expect(within(view).getByRole('combobox', { name: 'Link to' })).toHaveTextContent('Storefront');
    expect(await within(view).findByRole('combobox', { name: 'Team' })).toHaveTextContent(
      'Platform',
    );
    // One organization needs no picker; the description says where the project goes.
    expect(within(view).queryByRole('combobox', { name: 'Organization' })).toBeNull();
    expect(view).toHaveTextContent('Acme');

    await pick(user, 'Platform', 'Node.js');
    await user.click(within(view).getByRole('button', { name: 'Create project' }));

    expect(bridge.$fn('errorTracking.teams')).toHaveBeenCalledWith('c1');
    expect(bridge.$fn('errorTracking.createProject')).toHaveBeenCalledWith({
      connectionId: 'c1',
      teamSlug: 'platform',
      name: 'Storefront',
      platform: 'node',
      linkProjectId: 'p1',
    });
    expect(toast.success).toHaveBeenCalledWith('Created Checkout in Sentry');
  });

  it('follows the project to link until the name is typed over, and can link nothing', async () => {
    const { user, bridge } = renderDialog();
    const view = await dialog();
    const name = within(view).getByLabelText('Project name');

    await pick(user, 'Link to', 'Admin');
    expect(name).toHaveValue('Admin');
    await user.clear(name);
    await user.type(name, 'Admin API');
    await pick(user, 'Link to', 'Storefront');
    expect(name).toHaveValue('Admin API');

    await pick(user, 'Link to', 'Do not link');
    await within(view).findByRole('combobox', { name: 'Team' });
    await user.click(within(view).getByRole('button', { name: 'Create project' }));
    expect(bridge.$fn('errorTracking.createProject')).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Admin API', linkProjectId: null, platform: null }),
    );
  });

  it('checks the name and will not create without one', async () => {
    const { user } = renderDialog({ defaultProjectId: undefined });
    const view = await dialog();
    const name = within(view).getByLabelText('Project name');
    expect(name).toHaveValue('');
    await user.type(name, 'x');
    await user.clear(name);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Enter a name.');
    expect(within(view).getByRole('button', { name: 'Create project' })).toBeDisabled();
    await user.type(name, 'Worker');
    expect(name).toHaveAttribute('aria-invalid', 'false');
    await within(view).findByRole('combobox', { name: 'Team' });
    expect(within(view).getByRole('button', { name: 'Create project' })).toBeEnabled();
  });

  it('submits on Enter from the name field', async () => {
    const { user, bridge } = renderDialog();
    const view = await dialog();
    await within(view).findByRole('combobox', { name: 'Team' });
    await user.type(within(view).getByLabelText('Project name'), '{Enter}');
    await waitFor(() => expect(bridge.$fn('errorTracking.createProject')).toHaveBeenCalled());
  });

  it('says so when the organization has no team to put it under', async () => {
    renderDialog({}, { 'errorTracking.teams': [] });
    const view = await dialog();
    expect(await within(view).findByText(/has no team the token can see/)).toBeInTheDocument();
    expect(within(view).getByRole('button', { name: 'Create project' })).toBeDisabled();
  });

  it('picks between organizations, leaving out locked ones', async () => {
    const { user, bridge } = renderDialog({
      connections: [
        creator,
        connection({ id: 'c2', label: 'Side', locked: true, canCreateProjects: true }),
        connection({ id: 'c3', label: 'Beta', orgSlug: 'beta', canCreateProjects: true }),
      ],
    });
    const view = await dialog();
    await user.click(within(view).getByRole('combobox', { name: 'Organization' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((one) => one.textContent)).toEqual([
      expect.stringContaining('Acme'),
      expect.stringContaining('Beta'),
    ]);
    await user.click(options[1]);
    await waitFor(() => expect(bridge.$fn('errorTracking.teams')).toHaveBeenCalledWith('c3'));
  });

  it('stops a token that cannot create projects and says how to fix it', async () => {
    const { user, bridge, onReplaceToken } = renderDialog({ connections: [connection()] });
    const view = await dialog();
    expect(view).toHaveTextContent(/lacks the project:write scope/);
    expect(within(view).getByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(() => bridge.$fn('errorTracking.teams')).toThrow();
    await user.click(within(view).getByRole('button', { name: 'Copy scopes' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Scopes copied'));
    await user.click(within(view).getByRole('button', { name: 'Replace token' }));
    expect(onReplaceToken).toHaveBeenCalled();
  });

  it('lets a token whose scopes are unknown try', async () => {
    renderDialog({ connections: [connection({ scopes: null, canCreateProjects: null })] });
    const view = await dialog();
    await within(view).findByRole('combobox', { name: 'Team' });
    expect(within(view).getByRole('button', { name: 'Create project' })).toBeEnabled();
    expect(view).not.toHaveTextContent(/lacks the project:write scope/);
  });

  it('shows what Sentry said and keeps the form as it was', async () => {
    const { user } = renderDialog(
      {},
      {
        'errorTracking.createProject': async () => {
          throw new Error(
            "Error invoking remote method 'errorTracking:createProject': Error: Sentry refused the request (HTTP 409: A project with this slug already exists.).",
          );
        },
      },
    );
    const view = await dialog();
    await within(view).findByRole('combobox', { name: 'Team' });
    await user.click(within(view).getByRole('button', { name: 'Create project' }));
    expect(await within(view).findByRole('alert')).toHaveTextContent(
      'Sentry refused the request (HTTP 409: A project with this slug already exists.).',
    );
    expect(within(view).getByLabelText('Project name')).toHaveValue('Storefront');
    expect(within(view).getByRole('button', { name: 'Create project' })).toBeEnabled();
  });
});

describe('ErrorNewProjectDialog, once it is made', () => {
  async function create(bridge: Record<string, unknown> = {}) {
    const rendered = renderDialog({}, bridge);
    const view = await dialog();
    await within(view).findByRole('combobox', { name: 'Team' });
    await pick(rendered.user, 'Platform', 'Node.js');
    await rendered.user.click(within(view).getByRole('button', { name: 'Create project' }));
    await within(view).findByRole('heading', { name: 'Checkout is ready' });
    return { ...rendered, view };
  }

  it('shows the DSN to copy, where it is linked, and how to set it up', async () => {
    const { user, view } = await create();
    expect(within(view).getByRole('status')).toHaveTextContent('Checkout is ready');
    expect(view).toHaveTextContent('Linked to Storefront');
    expect(within(view).getByLabelText('DSN')).toHaveTextContent(DSN);

    await user.click(within(view).getByRole('button', { name: 'Copy DSN' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('DSN copied'));
    expect(await navigator.clipboard.readText()).toBe(DSN);
    await user.click(within(view).getByRole('button', { name: 'Copy as env var' }));
    expect(await navigator.clipboard.readText()).toBe(`SENTRY_DSN=${DSN}`);

    expect(within(view).getByRole('combobox', { name: 'Snippet platform' })).toHaveTextContent(
      'Node.js',
    );
    expect(within(view).getByRole('region', { name: 'Install' })).toHaveTextContent(
      'npm install --save @sentry/node',
    );
    expect(within(view).getByRole('region', { name: 'Init code' })).toHaveTextContent(DSN);

    await pick(user, 'Snippet platform', 'Python');
    expect(within(view).getByRole('region', { name: 'Install' })).toHaveTextContent(
      'pip install --upgrade sentry-sdk',
    );
    expect(within(view).getByRole('link', { name: /Python guide/ })).toHaveAttribute(
      'href',
      'https://docs.sentry.io/platforms/python/',
    );
    expect(within(view).getByRole('link', { name: /Open in Sentry/ })).toHaveAttribute(
      'href',
      'https://sentry.io/settings/acme/projects/checkout/keys/',
    );
  });

  it('closes on Done', async () => {
    const onOpenChange = vi.fn();
    const rendered = renderDialog({ onOpenChange });
    const view = await dialog();
    await within(view).findByRole('combobox', { name: 'Team' });
    await rendered.user.click(within(view).getByRole('button', { name: 'Create project' }));
    await rendered.user.click(await within(view).findByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says where to find the DSN when Sentry has not made a key yet', async () => {
    const { view } = await create({
      'errorTracking.createProject': async () =>
        createdProject({ dsn: null, keys: [], link: null }),
    });
    expect(view).toHaveTextContent(/has no client key yet/);
    expect(view).toHaveTextContent('Not linked to a project');
    expect(within(view).queryByLabelText('DSN')).toBeNull();
    expect(within(view).getByRole('link', { name: /Open keys in Sentry/ })).toHaveAttribute(
      'href',
      'https://sentry.io/settings/acme/projects/checkout/keys/',
    );
  });
});
