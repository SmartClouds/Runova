import { permissionDeniedMessage } from '@shared/cloudflare/permissions';
import { encodeCloudflareError } from '@shared/cloudflareErrors';
import type { EmailGatePlan } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import {
  CORE_HOST,
  deferred,
  EMAIL_GATE_PLAN,
  ipcError,
  SITE_HOST,
  ZONE,
} from '../testing/fixtures';

/**
 * The zone's Access tab (E96): every name with a switch for the email code gate. A switch turned
 * on opens the dialog that says who may ask for a code; turned off it asks first. Names without
 * Cloudflare's proxy offer to turn it on, gates made elsewhere are shown and left alone, and the
 * core domain says whether this computer has its pass.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { EmailGateCard } = await import('./EmailGateCard');

function renderCard(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <EmailGateCard zone={ZONE} />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'cloudflareEmailGate.plan': async () => EMAIL_GATE_PLAN,
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  localStorage.clear();
});

describe('EmailGateCard', () => {
  it('shows a placeholder in place while the names load', () => {
    const { container } = renderCard({
      'cloudflareEmailGate.plan': () => deferred<EmailGatePlan>().promise,
    });
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('lists each name with what it is and who can open it, the core domain first', async () => {
    renderCard();
    const list = await screen.findByRole('list', { name: 'Names in example.com' });
    const rows = within(list).getAllByRole('listitem');

    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'core.example.com',
      'blog.example.com',
      'shop.example.com',
      'wiki.example.com',
    ]);
    expect(within(rows[0]!).getByText('Core server')).toBeTruthy();
    expect(within(rows[0]!).getByText('Email code, 3 people, 24 hours')).toBeTruthy();
    expect(within(rows[1]!).getByText('Site blog')).toBeTruthy();
    expect(within(rows[1]!).getByText('Open to everyone')).toBeTruthy();
    expect(screen.getByText('1 of 4 names asks for an email code')).toBeTruthy();
    expect(
      within(rows[0]!)
        .getByRole('switch', { name: 'Email code for core.example.com' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('opens the dialog when a switch is turned on, and saves who may get in', async () => {
    const save = vi.fn(async () => ({
      kind: 'on',
      appId: 'x',
      emails: ['cy@example.com'],
      emailDomains: [],
      session: '24h',
    }));
    const { user, bridge } = renderCard({ 'cloudflareEmailGate.save': save });
    const row = await screen.findByRole('listitem', { name: 'blog.example.com' });

    await user.click(within(row).getByRole('switch', { name: 'Email code for blog.example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask for an email code' });
    await user.type(within(dialog).getByLabelText('Who can get a code'), 'cy@example.com{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on email code' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        zoneId: ZONE.id,
        hostname: 'blog.example.com',
        emails: ['cy@example.com'],
        emailDomains: [],
        session: '24h',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'blog.example.com now asks for an email code.',
      expect.anything(),
    );
    expect(bridge.$fn('cloudflareEmailGate.plan').mock.calls.length).toBeGreaterThan(1);
  });

  it('asks before a gate comes off, and takes it off', async () => {
    const remove = vi.fn(async () => undefined);
    const { user } = renderCard({ 'cloudflareEmailGate.remove': remove });
    const row = await screen.findByRole('listitem', { name: 'core.example.com' });

    await user.click(within(row).getByRole('switch', { name: 'Email code for core.example.com' }));
    const confirm = await screen.findByRole('dialog', { name: /Turn the email code off/ });
    expect(within(confirm).getByText(/anyone can open core\.example\.com/i)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Turn off' }));

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({ zoneId: ZONE.id, hostname: 'core.example.com' }),
    );
  });

  it('opens the dialog with the gate as it is to change it', async () => {
    const { user } = renderCard();
    const row = await screen.findByRole('listitem', { name: 'core.example.com' });

    await user.click(
      within(row).getByRole('button', { name: 'Edit email code for core.example.com' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Email code for core.example.com' });

    expect(within(dialog).getByText('ana@example.com')).toBeTruthy();
    expect(within(dialog).getByText('@company.com')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('offers to turn the proxy on for a name Cloudflare does not answer for', async () => {
    const proxy = vi.fn(async () => undefined);
    const { user } = renderCard({ 'cloudflareEmailGate.proxy': proxy });
    const row = await screen.findByRole('listitem', { name: 'shop.example.com' });

    expect(within(row).getByRole('switch')).toHaveProperty('disabled', true);
    await user.click(within(row).getByRole('button', { name: 'Turn on proxy' }));

    await waitFor(() =>
      expect(proxy).toHaveBeenCalledWith({ zoneId: ZONE.id, hostname: 'shop.example.com' }),
    );
  });

  it('shows a gate made elsewhere without a switch, with a way to it on Cloudflare', async () => {
    const { user, bridge } = renderCard();
    const row = await screen.findByRole('listitem', { name: 'wiki.example.com' });

    expect(within(row).queryByRole('switch')).toBeNull();
    expect(within(row).getByText('Team wiki, set up in Cloudflare')).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Open in Cloudflare' }));

    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(
      `https://one.dash.cloudflare.com/${ZONE.cloudflareAccountId}/access/apps/edit/7e1a0000-0000-4000-8000-000000000002`,
    );
  });

  it('lets this computer through the gate on the core domain when it has no pass', async () => {
    const through = vi.fn(async () => undefined);
    const { user } = renderCard({
      'cloudflareEmailGate.plan': async () => ({
        ...EMAIL_GATE_PLAN,
        hosts: [{ ...CORE_HOST, thisComputerPass: false }, SITE_HOST],
      }),
      'cloudflareEmailGate.letThisComputerThrough': through,
    });
    const row = await screen.findByRole('listitem', { name: 'core.example.com' });

    expect(within(row).getByText(/this computer has no pass/i)).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Let this computer through' }));

    await waitFor(() =>
      expect(through).toHaveBeenCalledWith({ zoneId: ZONE.id, hostname: 'core.example.com' }),
    );
  });

  it('turns email codes on for the account first, then lets the switches work', async () => {
    const prepare = vi.fn(async () => EMAIL_GATE_PLAN.readiness);
    const { user } = renderCard({
      'cloudflareEmailGate.plan': async () => ({
        ...EMAIL_GATE_PLAN,
        readiness: {
          organization: true,
          teamDomain: 'acme.cloudflareaccess.com',
          oneTimePin: false,
        },
        hosts: [SITE_HOST],
      }),
      'cloudflareEmailGate.prepare': prepare,
    });
    const row = await screen.findByRole('listitem', { name: 'blog.example.com' });

    expect(within(row).getByRole('switch')).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Turn on email codes' }));

    await waitFor(() => expect(prepare).toHaveBeenCalledWith({ zoneId: ZONE.id }));
  });

  it('asks for a team name when the account has no Zero Trust yet', async () => {
    const prepare = vi.fn(async () => EMAIL_GATE_PLAN.readiness);
    const { user } = renderCard({
      'cloudflareEmailGate.plan': async () => ({
        ...EMAIL_GATE_PLAN,
        readiness: { organization: false, teamDomain: null, oneTimePin: false },
        hosts: [SITE_HOST],
      }),
      'cloudflareEmailGate.prepare': prepare,
    });
    const name = await screen.findByLabelText('Team name');

    await user.type(name, 'Acme Ops');
    expect(screen.getByText(/lower case/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn on email codes' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.clear(name);
    await user.type(name, 'acme-ops');
    expect(screen.getByText('acme-ops.cloudflareaccess.com')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Turn on email codes' }));

    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith({ zoneId: ZONE.id, teamName: 'acme-ops' }),
    );
  });

  it('says exactly what to add to the token when Cloudflare refuses', async () => {
    renderCard({
      'cloudflareEmailGate.plan': async () => {
        throw ipcError(
          'plan',
          encodeCloudflareError(
            'missing-permission',
            permissionDeniedMessage('accessLogin'),
            'accessLogin',
          ),
        );
      },
    });

    expect(
      await screen.findByText(
        'Account > Access: Organizations, Identity Providers, and Groups > Edit',
      ),
    ).toBeTruthy();
  });

  it('says so when the zone has no names to put a gate on', async () => {
    renderCard({
      'cloudflareEmailGate.plan': async () => ({ ...EMAIL_GATE_PLAN, hosts: [] }),
    });
    expect(await screen.findByText('No names in example.com yet')).toBeTruthy();
  });
});
