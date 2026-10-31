import { encodeCoreError } from '@shared/coreErrors';
import type {
  CertificateInfo,
  CoreDomainStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployCoreDomainInfo } from '@shared/deployCoreDomainTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { SERVER, signedIn } from '../testing/fixtures';

/**
 * The core domain through its states: shimmer, a read that failed, nginx missing (form held back,
 * a way to Websites), the origin lock, off for a Viewer (read only), on for an Owner after a
 * step-up, waiting for a certificate (the issue dialog), ready with a check from this computer
 * (a Cloudflare proxy explained), a problem the core reports, and turning it off.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { CoreDomainCard } = await import('./CoreDomainCard');

const CERTIFICATE: CertificateInfo = {
  siteId: 'runova-core',
  source: 'acme',
  state: 'valid',
  domains: ['core.example.com'],
  issuer: "Let's Encrypt R11",
  notBeforeUnixMs: Date.now() - 86_400_000,
  notAfterUnixMs: Date.UTC(2046, 0, 1),
  autoRenew: true,
  staging: false,
  failedAttempts: 0,
};

function domain(fields: Partial<CoreDomainStatus> = {}): CoreDomainStatus {
  return {
    enabled: false,
    sources: [],
    nginxInstalled: true,
    nginxRunning: true,
    originLocked: false,
    listening: false,
    siteApplied: false,
    ready: false,
    siteId: 'runova-core',
    ...fields,
  };
}

const ON: Partial<CoreDomainStatus> = {
  enabled: true,
  domain: 'core.example.com',
  listening: true,
  siteApplied: true,
};

function info(
  fields: Partial<CoreDomainStatus> = {},
  extra: Partial<DeployCoreDomainInfo> = {},
): DeployCoreDomainInfo {
  return { status: domain(fields), route: null, ...extra };
}

function renderCard(
  overrides: Record<string, unknown> = {},
  role: 'owner' | 'admin' | 'viewer' = 'owner',
) {
  return renderWithProviders(
    <CoreDomainCard server={SERVER} owner={role === 'owner'} admin={role !== 'viewer'} />,
    {
      bridge: {
        'deploy.access': async () => signedIn([role]),
        'deploy.connection': async () => ({
          serverId: SERVER.id,
          state: 'online',
          since: 0,
          transport: 'streamlocal',
        }),
        'deployCoreDomain.status': async () => info(),
        'cloudflareServer.dnsTokens': async () => [],
        ...overrides,
      },
    },
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
});

describe('CoreDomainCard', () => {
  it('shimmers while it reads the core', () => {
    const { container } = renderCard({
      'deployCoreDomain.status': () => new Promise(() => undefined),
    });

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says why it could not read the core, and asks again on request', async () => {
    let calls = 0;
    const { user } = renderCard({
      'deployCoreDomain.status': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The SSH connection was refused.');
        return info();
      },
    });

    expect(await screen.findByText('The SSH connection was refused.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Off')).toBeTruthy();
  });

  it('holds the form back until nginx is installed, and points to Websites', async () => {
    const { user } = renderCard({
      'deployCoreDomain.status': async () => info({ nginxInstalled: false, nginxRunning: false }),
    });

    expect(await screen.findByText('nginx is not installed')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Turn on the core domain/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByLabelText('Domain') as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: /Open Websites/ }));
  });

  it('says nginx has to run when it is installed but stopped', async () => {
    renderCard({ 'deployCoreDomain.status': async () => info({ nginxRunning: false }) });

    expect(await screen.findByText('nginx is not running')).toBeTruthy();
  });

  it('explains that the Cloudflare origin lock has to go first', async () => {
    renderCard({ 'deployCoreDomain.status': async () => info({ originLocked: true }) });

    expect(await screen.findByText('The Cloudflare origin lock is on')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Turn on the core domain/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('shows a Viewer how it stands and nothing to change', async () => {
    renderCard({}, 'viewer');

    const details = await screen.findByLabelText('Core domain details');
    expect(within(details).getByText('Off')).toBeTruthy();
    expect(within(details).getByText(/Uses direct TLS or SSH/)).toBeTruthy();
    expect(screen.getByText('Only an Owner can change the core domain.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Turn on the core domain/ })).toBeNull();
    expect(screen.getByText(/grey cloud, DNS only/)).toBeTruthy();
  });

  it('checks the form as the Owner types', async () => {
    const { user, bridge } = renderCard();

    await user.type(await screen.findByLabelText('Domain'), '*.example.com');
    await user.type(screen.getByLabelText('Allowed from'), '0.0.0.0/0');
    await user.click(screen.getByRole('button', { name: /Turn on the core domain/ }));

    expect(
      screen.getByText('The server core answers for one domain, not a wildcard.'),
    ).toBeTruthy();
    expect(screen.getByText('Leave the sources empty to allow every address.')).toBeTruthy();
    expect(() => bridge.$fn('deployCoreDomain.enable')).toThrow(/not been touched/);
  });

  it('turns it on after a step-up and then asks for a certificate', async () => {
    let calls = 0;
    const { user, bridge } = renderCard({
      'deployCoreDomain.enable': async () => {
        calls += 1;
        if (calls === 1)
          throw new Error(encodeCoreError('stepUpRequired', 'Needs your password again.'));
        return info({ ...ON, sources: ['10.0.0.0/8'] });
      },
      'deployCerts.issue': async () => ({
        id: 'job-1',
        kind: 'certificateIssue',
        state: 'running',
      }),
    });

    await user.type(await screen.findByLabelText('Domain'), 'Core.Example.com');
    await user.type(screen.getByLabelText('Allowed from'), '10.0.0.0/8');
    await user.click(screen.getByRole('button', { name: /Turn on the core domain/ }));
    await user.type(await screen.findByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(bridge.$fn('deployCoreDomain.enable')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      domain: 'core.example.com',
      sources: ['10.0.0.0/8'],
      password: 'secret',
    });
    expect(await screen.findByText('On, waiting for a certificate')).toBeTruthy();
    expect(screen.getByText('https://core.example.com')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Get a certificate/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue a certificate' });
    expect(within(dialog).getByText(/core\.example\.com reach this server/)).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: /Issue the certificate/ }));
    await waitFor(() =>
      expect(bridge.$fn('deployCerts.issue')).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: SERVER.id,
          siteId: 'runova-core',
          acceptTermsOfService: true,
        }),
      ),
    );
  });

  it('offers no certificate to a member below Admin', async () => {
    renderCard({ 'deployCoreDomain.status': async () => info(ON) }, 'viewer');

    expect(await screen.findByText('On, waiting for a certificate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Get a certificate/ })).toBeNull();
  });

  it('shows a ready domain and checks it from this computer', async () => {
    const { user, bridge } = renderCard({
      'deploy.connection': async () => ({
        serverId: SERVER.id,
        state: 'online',
        since: 0,
        transport: 'core-domain',
      }),
      'deployCoreDomain.status': async () =>
        info(
          {
            ...ON,
            ready: true,
            certificate: CERTIFICATE,
            changedBy: 'maria',
            changedAtUnixMs: Date.now() - 120_000,
          },
          { route: { enabled: true, domain: 'core.example.com' } },
        ),
      'deployCoreDomain.check': async () =>
        info(
          { ...ON, ready: true, certificate: CERTIFICATE },
          {
            route: { enabled: true, domain: 'core.example.com' },
            check: { ok: true, checkedAt: Date.now() },
          },
        ),
    });

    const details = await screen.findByLabelText('Core domain details');
    expect(within(details).getByText('On, answering at core.example.com')).toBeTruthy();
    expect(within(details).getByText(/Tries the core domain first/)).toBeTruthy();
    expect(within(details).getByText(/Connected through the core domain/)).toBeTruthy();
    expect(within(details).getByText(/Let's Encrypt R11/)).toBeTruthy();
    expect(within(details).getByText(/by maria/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Get a certificate/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Check from this computer/ }));

    expect(bridge.$fn('deployCoreDomain.check')).toHaveBeenCalledWith(SERVER.id);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'This computer reached the core through the domain.',
      ),
    );
  });

  it('explains a Cloudflare proxy in front of the domain', async () => {
    renderCard({
      'deployCoreDomain.status': async () =>
        info(
          { ...ON, ready: true, certificate: CERTIFICATE },
          {
            check: {
              ok: false,
              checkedAt: Date.now(),
              problem: 'cloudflare-proxy',
              message: 'Cloudflare answered.',
            },
          },
        ),
    });

    const details = await screen.findByLabelText('Core domain details');
    expect(within(details).getByText(/turn the proxy off for this record/)).toBeTruthy();
    expect(
      within(details).getByText(/Does not use the domain until a check from here passes/),
    ).toBeTruthy();
  });

  it('shows what the core says is wrong, and a certificate the app cannot use', async () => {
    renderCard({
      'deployCoreDomain.status': async () =>
        info({
          ...ON,
          listening: false,
          error: 'The core could not open its port for nginx (41234).',
          certificate: { ...CERTIFICATE, staging: true },
        }),
    });

    const details = await screen.findByLabelText('Core domain details');
    expect(within(details).getByText("On, but the core's port for nginx is not open")).toBeTruthy();
    expect(within(details).getByText(/could not open its port for nginx/)).toBeTruthy();
    expect(within(details).getByText(/staging CA/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Get a certificate/ })).toBeTruthy();
  });

  it('turns it off after a confirmation', async () => {
    const { user, bridge } = renderCard({
      'deployCoreDomain.status': async () => info({ ...ON, ready: true, certificate: CERTIFICATE }),
      'deployCoreDomain.disable': async () => info({ domain: 'core.example.com' }),
    });

    await user.click(await screen.findByRole('button', { name: /Turn off/ }));

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(bridge.$fn('deployCoreDomain.disable')).toHaveBeenCalledWith(SERVER.id);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('The core domain is off.'));
    expect(await screen.findByText('Off')).toBeTruthy();
  });

  it('changes the domain of a mode that is on', async () => {
    const { user, bridge } = renderCard({
      'deployCoreDomain.status': async () => info({ ...ON, ready: true, certificate: CERTIFICATE }),
      'deployCoreDomain.enable': async () => info({ ...ON, domain: 'api.example.com' }),
    });

    await user.click(await screen.findByRole('button', { name: /Change domain or sources/ }));
    const field = screen.getByLabelText('Domain');
    await user.clear(field);
    await user.type(field, 'api.example.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(bridge.$fn('deployCoreDomain.enable')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        domain: 'api.example.com',
        sources: [],
      }),
    );
  });

  it('says why a change could not be made', async () => {
    const { user } = renderCard({
      'deployCoreDomain.enable': async () => {
        throw new Error('core.example.com already belongs to the site blog.');
      },
    });

    await user.type(await screen.findByLabelText('Domain'), 'core.example.com');
    await user.click(screen.getByRole('button', { name: /Turn on the core domain/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'core.example.com already belongs to the site blog.',
      ),
    );
  });
});
