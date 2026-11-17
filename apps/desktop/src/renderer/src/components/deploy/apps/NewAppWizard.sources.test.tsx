import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import type { AppsAccess } from './hooks';
import { appsBridge, SERVER, sampleJob, samplePreview, uploadResult } from './testing/fixtures';

/**
 * Where an app's images come from (E105): Docker Registry is picked and recommended, a GitHub
 * Release is picked from the project's repository with the server's access to it in view, and a
 * local folder sends nothing until its size is approved.
 */

const { NewAppWizard } = await import('./NewAppWizard');

const OWNER: AppsAccess = {
  pending: false,
  signedIn: true,
  roles: ['owner'],
  canOperate: true,
  canAdmin: true,
};

const DIGEST = 'a'.repeat(64);

const RELEASES = {
  repository: 'acme/shop',
  releases: [
    {
      tag: 'v1.5.0-rc.1',
      name: '',
      prerelease: true,
      publishedAtUnixMs: 3,
      assets: [{ id: 90, name: 'rc.tar.gz', size: 10, sha256: DIGEST }],
    },
    {
      tag: 'v1.4.0',
      name: 'Shop 1.4.0',
      prerelease: false,
      publishedAtUnixMs: 2,
      assets: [{ id: 77, name: 'shop-image.tar.gz', size: 3 * 1024 * 1024, sha256: DIGEST }],
    },
  ],
};

function renderWizard(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <NewAppWizard
      serverId={SERVER.id}
      access={OWNER}
      onCancel={() => undefined}
      onOpenApp={() => undefined}
    />,
    {
      bridge: {
        ...appsBridge(),
        'deployStacks.list': [],
        'deploy.listServers': [SERVER],
        ...bridge,
      },
    },
  );
}

type User = ReturnType<typeof renderWizard>['user'];

async function pickSource(user: User) {
  await user.click(await screen.findByRole('combobox', { name: 'Project' }));
  await user.click(await screen.findByRole('option', { name: 'Shop' }));
  await user.click(await screen.findByRole('radio', { name: /compose\.yaml/ }));
  const environment = screen.getByRole('combobox', { name: 'Environment' });
  await waitFor(() => expect(environment).toBeEnabled());
  await user.click(environment);
  await user.click(await screen.findByRole('option', { name: 'Production' }));
}

async function toReview(user: User) {
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByRole('list', { name: 'Services to deploy' });
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByRole('list', { name: 'Exposure' });
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByRole('list', { name: 'Findings to accept' });
}

async function acceptAll(user: User) {
  for (const box of screen.queryAllByRole('checkbox')) {
    if (!(box as HTMLInputElement).checked) await user.click(box);
  }
}

describe('NewAppWizard image sources (E105)', () => {
  it('picks Docker Registry by default and marks it recommended', async () => {
    const { user } = renderWizard();
    await pickSource(user);

    const sources = screen.getByRole('radiogroup', { name: 'Where the images come from' });
    const radios = within(sources).getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual([
      expect.stringContaining('Docker Registry'),
      expect.stringContaining('GitHub Release'),
      expect.stringContaining('Local Folder'),
    ]);
    expect(within(sources).getByRole('radio', { name: /Docker Registry/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(sources).getByText('Recommended')).toBeInTheDocument();
  });

  it('picks the newest release image, shows how the server reaches it and deploys it', async () => {
    const { user, bridge } = renderWizard({
      'deployStacks.releases': RELEASES,
      'deployStacks.releaseAccess': {
        repository: 'acme/shop',
        access: 'none',
        message: 'The server cannot read the releases of acme/shop on its own.',
      },
      'deployStacks.create': uploadResult(),
      'deployStacks.deploy': sampleJob(),
    });
    await pickSource(user);

    await user.click(screen.getByRole('radio', { name: /GitHub Release/ }));

    expect(
      await screen.findByText(/downloads shop-image\.tar\.gz \(3\.0 MB\)/),
    ).toBeInTheDocument();
    expect(bridge.$fn('deployStacks.releases')).toHaveBeenCalledWith({ projectId: 'proj-1' });
    const access = await screen.findByRole('region', { name: 'Server access to the releases' });
    expect(within(access).getByText(/cannot read the releases of acme\/shop/)).toBeInTheDocument();
    expect(within(access).getByText(/This deploy still works/)).toBeInTheDocument();

    await toReview(user);
    const goes = screen.getByRole('region', { name: 'What goes to the server' });
    expect(within(goes).getByText(/the server downloads shop-image\.tar\.gz/)).toBeInTheDocument();
    await acceptAll(user);
    await user.click(screen.getByRole('button', { name: /Deploy shop/ }));

    await waitFor(() =>
      expect(bridge.$fn('deployStacks.create')).toHaveBeenCalledWith(
        expect.objectContaining({
          imageSource: 'release',
          release: {
            repository: 'acme/shop',
            tag: 'v1.4.0',
            assetId: 77,
            assetName: 'shop-image.tar.gz',
            size: 3 * 1024 * 1024,
            sha256: DIGEST,
          },
        }),
      ),
    );
  });

  it('walks an Admin through giving the server a read-only token', async () => {
    const { user, bridge } = renderWizard({
      'deployStacks.releases': RELEASES,
      'deployStacks.releaseAccess': {
        repository: 'acme/shop',
        access: 'none',
        message: 'The server cannot read the releases of acme/shop on its own.',
      },
      'deployStacks.saveReleaseToken': {
        id: 't1',
        repository: 'acme/shop',
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      },
      'shell.openExternal': async () => undefined,
    });
    await pickSource(user);
    await user.click(screen.getByRole('radio', { name: /GitHub Release/ }));
    const access = await screen.findByRole('region', { name: 'Server access to the releases' });

    await user.click(within(access).getByRole('button', { name: /Give the server access/ }));
    expect(within(access).getByText(/set Contents to Read-only/)).toBeInTheDocument();
    await user.click(within(access).getByRole('button', { name: /Open GitHub/ }));
    await user.type(within(access).getByLabelText('Token'), 'github_pat_abc');
    await user.click(within(access).getByRole('button', { name: /Check and store/ }));

    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(
      'https://github.com/settings/personal-access-tokens/new',
    );
    await waitFor(() =>
      expect(bridge.$fn('deployStacks.saveReleaseToken')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        repository: 'acme/shop',
        token: 'github_pat_abc',
      }),
    );
  });

  it('says why the picked source cannot deploy the compose file, and offers another', async () => {
    const { user } = renderWizard({
      'deployStacks.preview': samplePreview({
        sourceBlocking: {
          registry: 'api builds from source and names no image:, so there is nothing to pull.',
          release: null,
          local: null,
        },
      }),
    });
    await pickSource(user);
    await user.click(screen.getByRole('button', { name: /Next/ }));

    expect(
      await screen.findByText(/Docker Registry cannot deploy this compose file: api builds/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Next/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Pick another source/ }));
    expect(
      screen.getByRole('radiogroup', { name: 'Where the images come from' }),
    ).toBeInTheDocument();
  });

  it('lists the files the compose file reads as all that goes with a registry deploy', async () => {
    const { user } = renderWizard({
      'deployStacks.preview': samplePreview({ projectFiles: ['nginx.conf'] }),
    });
    await pickSource(user);
    await toReview(user);

    const goes = screen.getByRole('region', { name: 'What goes to the server' });
    expect(within(goes).getByText('nginx.conf')).toBeInTheDocument();
    expect(within(goes).queryByText(/compose folder/)).not.toBeInTheDocument();
  });

  it('sends a local folder only after its size is approved, and nothing when it is not', async () => {
    const plan = {
      approvalId: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
      archiveBytes: 2.5 * 1024 * 1024,
      contentBytes: 9 * 1024 * 1024,
      entries: 412,
      largest: [{ path: 'public', bytes: 6 * 1024 * 1024 }],
    };
    const { user, bridge } = renderWizard({
      'deployStacks.prepareLocal': plan,
      'deployStacks.cancelLocal': async () => undefined,
      'deployStacks.create': uploadResult(),
      'deployStacks.deploy': sampleJob(),
    });
    await pickSource(user);
    await user.click(screen.getByRole('radio', { name: /Local Folder/ }));
    await toReview(user);
    await acceptAll(user);

    await user.click(screen.getByRole('button', { name: /Deploy shop/ }));
    const approval = await screen.findByRole('region', { name: 'Approve the upload' });
    expect(within(approval).getByText('2.5 MB')).toBeInTheDocument();
    expect(within(approval).getByText('412')).toBeInTheDocument();
    expect(within(approval).getByText('public')).toBeInTheDocument();
    await user.click(within(approval).getByRole('button', { name: 'Do not send' }));

    expect(bridge.$fn('deployStacks.cancelLocal')).toHaveBeenCalledWith(plan.approvalId);
    await screen.findByRole('list', { name: 'Findings to accept' });

    await user.click(screen.getByRole('button', { name: /Deploy shop/ }));
    const again = await screen.findByRole('region', { name: 'Approve the upload' });
    await user.click(within(again).getByRole('button', { name: /Send 2\.5 MB and deploy/ }));

    await waitFor(() =>
      expect(bridge.$fn('deployStacks.create')).toHaveBeenCalledWith(
        expect.objectContaining({ imageSource: 'local', approvalId: plan.approvalId }),
      ),
    );
  });
});
