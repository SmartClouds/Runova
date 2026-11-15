import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CORE_HOST, ipcError, SITE_HOST, ZONE } from '../testing/fixtures';

/**
 * The email code gate's dialog (E96): who may ask for a code, as chips that take addresses and
 * whole domains typed or pasted, how long they stay in, and a sentence that says it back in plain
 * words. A new gate starts from the last list used here; an existing one shows its own.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { EmailGateDialog } = await import('./EmailGateDialog');

const onOpenChange = vi.fn();

function renderDialog(host = SITE_HOST, bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <EmailGateDialog open zone={ZONE} host={host} onOpenChange={onOpenChange} />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'cloudflareEmailGate.save': async () => ({ kind: 'on' }),
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  localStorage.clear();
  onOpenChange.mockClear();
  toast.success.mockClear();
});

describe('EmailGateDialog', () => {
  it('turns typed and pasted entries into chips, domains as everyone there', async () => {
    const { user } = renderDialog();
    const field = await screen.findByLabelText('Who can get a code');

    await user.type(field, 'ana@example.com,');
    await user.type(field, '@Company.com{Enter}');
    await user.click(field);
    await user.paste('Bo Silva <bo@example.com>; not-an-email');

    const chips = screen.getByRole('list', { name: 'Listed people and domains' });
    expect(within(chips).getByText('ana@example.com')).toBeTruthy();
    expect(within(chips).getByText('@company.com')).toBeTruthy();
    expect(within(chips).getByText('bo@example.com')).toBeTruthy();
    expect(screen.getByText(/not-an-email/)).toBeTruthy();
    expect(
      screen.getByText(
        'Anyone at @company.com and 2 more people can open blog.example.com for 24 hours after typing a code.',
      ),
    ).toBeTruthy();
  });

  it('removes a chip with its button or Backspace', async () => {
    const { user } = renderDialog();
    const field = await screen.findByLabelText('Who can get a code');
    await user.type(field, 'ana@example.com bo@example.com ');

    await user.click(screen.getByRole('button', { name: 'Remove ana@example.com' }));
    await user.type(field, '{Backspace}');

    expect(screen.queryByText('ana@example.com')).toBeNull();
    expect(screen.queryByText('bo@example.com')).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn on email code' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('saves the people and the session picked, and remembers the list for next time', async () => {
    const save = vi.fn(async () => ({ kind: 'on' }));
    const { user } = renderDialog(SITE_HOST, { 'cloudflareEmailGate.save': save });
    await user.type(
      await screen.findByLabelText('Who can get a code'),
      'ana@example.com company.com ',
    );
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await user.click(screen.getByRole('button', { name: 'Turn on email code' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        zoneId: ZONE.id,
        hostname: 'blog.example.com',
        emails: ['ana@example.com'],
        emailDomains: ['company.com'],
        session: '168h',
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(JSON.parse(localStorage.getItem('runova:email-gate-last-people') ?? '{}')).toEqual({
      emails: ['ana@example.com'],
      emailDomains: ['company.com'],
    });
  });

  it('starts a new gate from the last list used', async () => {
    localStorage.setItem(
      'runova:email-gate-last-people',
      JSON.stringify({ emails: ['ana@example.com'], emailDomains: ['company.com'] }),
    );
    renderDialog();

    expect(await screen.findByText('ana@example.com')).toBeTruthy();
    expect(screen.getByText('@company.com')).toBeTruthy();
    expect(screen.getByText(/from the last list you used/i)).toBeTruthy();
  });

  it("shows an existing gate's own people and session, and says this computer keeps its pass", async () => {
    localStorage.setItem(
      'runova:email-gate-last-people',
      JSON.stringify({ emails: ['zed@example.com'], emailDomains: [] }),
    );
    renderDialog(CORE_HOST);

    expect(await screen.findByText('ana@example.com')).toBeTruthy();
    expect(screen.queryByText('zed@example.com')).toBeNull();
    expect(screen.getByRole('radio', { name: '24 hours' })).toHaveProperty('ariaChecked', 'true');
    expect(screen.getByText(/this computer has its own pass/i)).toBeTruthy();
  });

  it('turns an existing gate off after asking, and only an existing one', async () => {
    const remove = vi.fn(async () => undefined);
    const { user } = renderDialog(CORE_HOST, { 'cloudflareEmailGate.remove': remove });

    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const confirm = await screen.findByRole('dialog', { name: /Turn the email code off/ });
    await user.click(within(confirm).getByRole('button', { name: 'Turn off' }));

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({ zoneId: ZONE.id, hostname: 'core.example.com' }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('has no Turn off button for a new gate', async () => {
    renderDialog();
    await screen.findByLabelText('Who can get a code');
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
  });

  it('keeps the dialog open with the reason when Cloudflare refuses', async () => {
    const { user } = renderDialog(SITE_HOST, {
      'cloudflareEmailGate.save': async () => {
        throw ipcError('save', 'Cloudflare is having a moment.');
      },
    });
    await user.type(await screen.findByLabelText('Who can get a code'), 'ana@example.com ');
    await user.click(screen.getByRole('button', { name: 'Turn on email code' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Cloudflare is having a moment.'),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
