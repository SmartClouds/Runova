// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApiClientEditor from '../src/components/admin/ApiClientEditor';
import ApiClientList from '../src/components/admin/ApiClientList';
import { API_CLIENT, NEW_SECRET, page, SECRET } from './fixtures/admin/staff';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const etag = (version: string) => ({ headers: { etag: `"${version}"` } });
const revoked = { ...API_CLIENT, revokedAt: '2026-10-31T10:00:00.000Z', version: '889' };

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/admin/api-clients');
});

describe('ApiClientList', () => {
  it('lists the active clients with their scopes, current key and last use', async () => {
    fakeFetch({
      'GET /api/v1/api-clients?revoked=false&page=1&pageSize=20': json(page([API_CLIENT])),
    });
    render(<ApiClientList />);

    const link = await screen.findByRole('link', { name: 'Advisory importer' });
    expect(link).toHaveAttribute('href', '/admin/api-clients/3');
    const row = screen.getAllByRole('row')[1];
    expect(row).toHaveTextContent('news:write');
    expect(row).toHaveTextContent('rk_5f2c9a1e7b3d4c60');
    expect(row).toHaveTextContent('Active');
    expect(screen.getByRole('link', { name: 'New API client' })).toHaveAttribute(
      'href',
      '/admin/api-clients/new',
    );
  });

  it('shows the revoked ones on request, marked as revoked', async () => {
    fakeFetch({
      'GET /api/v1/api-clients?revoked=false&page=1&pageSize=20': json(page([])),
      'GET /api/v1/api-clients?revoked=true&page=1&pageSize=20': json(page([revoked])),
    });
    const user = userEvent.setup();
    render(<ApiClientList />);
    expect(await screen.findByText('No API clients here.')).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Show'), 'revoked');

    const row = (await screen.findByRole('link', { name: 'Advisory importer' })).closest('tr');
    expect(row).toHaveTextContent('Revoked');
    expect(window.location.search).toBe('?show=revoked');
  });

  it('marks a client past its expiry as expired', async () => {
    const expired = { ...API_CLIENT, expiresAt: '2020-01-01T00:00:00.000Z' };
    fakeFetch({
      'GET /api/v1/api-clients?revoked=false&page=1&pageSize=20': json(page([expired])),
    });
    render(<ApiClientList />);

    const row = (await screen.findByRole('link', { name: 'Advisory importer' })).closest('tr');
    expect(row).toHaveTextContent('Expired');
  });
});

describe('ApiClientEditor, a new client', () => {
  it('creates the client, shows the secret once, then opens the client without it', async () => {
    const navigate = vi.fn();
    const api = fakeFetch({
      'POST /api/v1/api-clients': json(
        { client: API_CLIENT, keyId: 'rk_5f2c9a1e7b3d4c60', secret: SECRET },
        { status: 201 },
      ),
    });
    const user = userEvent.setup();
    render(<ApiClientEditor navigate={navigate} />);

    await user.type(screen.getByLabelText('Name'), 'Advisory importer');
    await user.click(screen.getByLabelText(/news:write/));
    await user.type(screen.getByLabelText('Allowed IP addresses'), '203.0.113.0/24\n2001:db8::1');
    await user.click(screen.getByRole('button', { name: 'Create client' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Copy the secret now' });
    expect(within(dialog).getByLabelText('Secret')).toHaveValue(SECRET);
    expect(api.calls('POST /api/v1/api-clients')[0].json()).toEqual({
      name: 'Advisory importer',
      scopes: ['news:write'],
      ipAllowlist: ['203.0.113.0/24', '2001:db8::1'],
      expiresAt: null,
    });
    expect(navigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'I have saved the secret' }));
    expect(navigate).toHaveBeenCalledWith('/admin/api-clients/3');
  });

  it('puts the API field errors under their fields', async () => {
    fakeFetch({
      'POST /api/v1/api-clients': problem(400, 'validation-failed', {
        errors: { name: ['Give the client a name.'], 'ipAllowlist[0]': ['Not an IP address.'] },
      }),
    });
    const user = userEvent.setup();
    render(<ApiClientEditor navigate={() => {}} />);

    await user.type(screen.getByLabelText('Allowed IP addresses'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Create client' }));

    expect(await screen.findByText('Give the client a name.')).toBeVisible();
    expect(screen.getByText('Entry 1: Not an IP address.')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('ApiClientEditor, an existing client', () => {
  it('shows the client and its keys but never a secret', async () => {
    fakeFetch({ 'GET /api/v1/api-clients/3': json(API_CLIENT, etag('887')) });
    render(<ApiClientEditor id={3} navigate={() => {}} />);

    expect(await screen.findByLabelText('Name')).toHaveValue('Advisory importer');
    expect(screen.getByLabelText(/news:write/)).toBeChecked();
    expect(screen.getByLabelText(/posts:write/)).not.toBeChecked();
    expect(screen.getByLabelText('Allowed IP addresses')).toHaveValue('203.0.113.0/24');
    expect(screen.getByText('rk_5f2c9a1e7b3d4c60')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/rnv_sk_/);
    expect(screen.queryByLabelText('Secret')).toBeNull();
  });

  it('saves changes as a merge patch against the version it loaded', async () => {
    const api = fakeFetch({
      'GET /api/v1/api-clients/3': json(API_CLIENT, etag('887')),
      'PATCH /api/v1/api-clients/3': json(
        { ...API_CLIENT, scopes: ['news:write', 'posts:write'], ipAllowlist: [], version: '888' },
        etag('888'),
      ),
    });
    const user = userEvent.setup();
    render(<ApiClientEditor id={3} navigate={() => {}} />);

    await user.click(await screen.findByLabelText(/posts:write/));
    await user.clear(screen.getByLabelText('Allowed IP addresses'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    const [patch] = api.calls('PATCH /api/v1/api-clients/3');
    expect(patch.headers.get('if-match')).toBe('"887"');
    expect(patch.headers.get('content-type')).toBe('application/merge-patch+json');
    expect(patch.json()).toEqual({
      name: 'Advisory importer',
      scopes: ['news:write', 'posts:write'],
      ipAllowlist: [],
      expiresAt: null,
    });
  });

  it('rotates after a confirmation, shows the new secret once, then lists the new key', async () => {
    const rotated = {
      ...API_CLIENT,
      keys: [
        { ...API_CLIENT.keys[0], expiresAt: '2026-10-31T11:00:00.000Z' },
        { keyId: 'rk_0123456789abcdef', createdAt: '2026-10-31T10:00:00.000Z', expiresAt: null },
      ],
      version: '888',
    };
    const api = fakeFetch({
      'GET /api/v1/api-clients/3': [json(API_CLIENT, etag('887')), json(rotated, etag('888'))],
      'POST /api/v1/api-clients/3/secrets': json(
        {
          keyId: 'rk_0123456789abcdef',
          secret: NEW_SECRET,
          previousKeyExpiresAt: '2026-10-31T11:00:00.000Z',
        },
        { status: 201 },
      ),
    });
    const user = userEvent.setup();
    render(<ApiClientEditor id={3} navigate={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Rotate secret' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Rotate the secret?' });
    await user.selectOptions(within(confirm).getByLabelText('The old key keeps working'), '60');
    expect(api.calls('POST /api/v1/api-clients/3/secrets')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Rotate' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Copy the secret now' });
    expect(within(dialog).getByLabelText('Secret')).toHaveValue(NEW_SECRET);
    expect(api.calls('POST /api/v1/api-clients/3/secrets')[0].json()).toEqual({
      overlapMinutes: 60,
    });

    await user.click(screen.getByRole('button', { name: 'I have saved the secret' }));
    expect(await screen.findByText('rk_0123456789abcdef')).toBeVisible();
    expect(document.body.textContent).not.toContain(NEW_SECRET);
    // The confirmation that opened the secret is gone, so focus goes back to its button.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Rotate secret' })).toHaveFocus(),
    );
  });

  it('revokes only after a confirmation and then shows the client as revoked', async () => {
    const api = fakeFetch({
      'GET /api/v1/api-clients/3': [json(API_CLIENT, etag('887')), json(revoked, etag('889'))],
      'DELETE /api/v1/api-clients/3': new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<ApiClientEditor id={3} navigate={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Revoke client' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Revoke Advisory importer?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(api.calls('DELETE /api/v1/api-clients/3')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Revoke client' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' }),
    );

    expect(await screen.findByText(/This client was revoked/)).toBeVisible();
    expect(api.calls('DELETE /api/v1/api-clients/3')[0].headers.get('if-match')).toBe('"887"');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rotate secret' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Revoke client' })).toBeNull();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    // The Revoke button is gone, so focus moves to the note that says what happened.
    await waitFor(() => expect(screen.getByText(/This client was revoked/)).toHaveFocus());
  });
});
