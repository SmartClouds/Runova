// @vitest-environment jsdom
import './setup/dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import InviteForm from '../src/components/admin/InviteForm';
import SetPasswordForm from '../src/components/admin/SetPasswordForm';
import UserEditor from '../src/components/admin/UserEditor';
import UserList, { filterQuery, readFilters } from '../src/components/admin/UserList';
import { isStaffUser, roleOf, userStatus } from '../src/lib/admin/users';
import { page, SETUP_LINK, STAFF_USER } from './fixtures/admin/staff';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const etag = (version: string) => ({ headers: { etag: `"${version}"` } });
const account = {
  ...STAFF_USER,
  id: 12,
  email: 'ada@example.com',
  displayName: 'Ada Account',
  roles: [],
  twoFactorEnabled: false,
  version: '77',
};
const invited = {
  ...STAFF_USER,
  id: 8,
  email: 'new@runovahq.com',
  displayName: 'New Person',
  emailConfirmed: false,
  twoFactorEnabled: false,
  lastSignInAt: null,
};

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/admin/users');
});

describe('UserList', () => {
  it('lists the staff with their role, status and two-factor', async () => {
    const admin = { ...STAFF_USER, id: 1, displayName: 'Ada Admin', roles: ['Admin'] };
    const disabled = { ...STAFF_USER, id: 9, displayName: 'Old Editor', disabled: true };
    fakeFetch({
      'GET /api/v1/users?page=1&pageSize=20': json(page([admin, STAFF_USER, invited, disabled])),
    });
    render(<UserList />);

    const link = await screen.findByRole('link', { name: 'Sam Editor' });
    expect(link).toHaveAttribute('href', '/admin/users/7');
    const cells = (name: string) =>
      within(screen.getByRole('link', { name }).closest('tr') as HTMLElement)
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells('Ada Admin')).toEqual(['editor@runovahq.com', 'Admin', 'Active', 'On']);
    expect(cells('New Person')).toEqual(['new@runovahq.com', 'Editor', 'Invited', 'Off']);
    expect(cells('Old Editor')).toEqual(['editor@runovahq.com', 'Editor', 'Disabled', 'On']);
    expect(screen.getByRole('link', { name: 'Invite a user' })).toHaveAttribute(
      'href',
      '/admin/users/new',
    );
  });
});

describe('UserList filters', () => {
  it('shows a Runova account as an account, and one that never verified its email as such', async () => {
    fakeFetch({
      'GET /api/v1/users?page=1&pageSize=20': json(
        page([account, { ...account, id: 13, displayName: 'New Account', emailConfirmed: false }]),
      ),
    });
    render(<UserList />);

    await screen.findByRole('link', { name: 'Ada Account' });
    const cells = (name: string) =>
      within(screen.getByRole('link', { name }).closest('tr') as HTMLElement)
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells('Ada Account')).toEqual(['ada@example.com', 'Runova account', 'Active', 'Off']);
    expect(cells('New Account')).toEqual([
      'ada@example.com',
      'Runova account',
      'Email not verified',
      'Off',
    ]);
  });

  it('searches by name or email and keeps the search in the address', async () => {
    const api = fakeFetch({
      'GET /api/v1/users?page=1&pageSize=20': json(page([STAFF_USER, account])),
      'GET /api/v1/users?q=ada&page=1&pageSize=20': json(page([account])),
    });
    const user = userEvent.setup();
    render(<UserList />);
    await screen.findByRole('link', { name: 'Sam Editor' });

    await user.type(screen.getByRole('searchbox', { name: 'Name or email' }), '  ada ');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByRole('link', { name: 'Ada Account' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Sam Editor' })).toBeNull();
    expect(window.location.search).toBe('?q=ada');
    expect(api.calls('GET /api/v1/users?q=ada&page=1&pageSize=20')).toHaveLength(1);
    // jsdom gives <search> no landmark role yet, so look for the element itself.
    expect(document.querySelector('search[aria-label="Users"]')).toContainElement(
      screen.getByRole('searchbox', { name: 'Name or email' }),
    );
  });

  it('filters by type and status, starting again from the first page, and clears both', async () => {
    window.history.replaceState(null, '', '/admin/users?page=2');
    const api = fakeFetch({
      'GET /api/v1/users?page=2&pageSize=20': json(page([STAFF_USER], 2, 2)),
      'GET /api/v1/users?role=Account&page=1&pageSize=20': json(page([account])),
      'GET /api/v1/users?role=Account&disabled=true&page=1&pageSize=20': json(page([])),
      'GET /api/v1/users?page=1&pageSize=20': json(page([STAFF_USER, account])),
    });
    const user = userEvent.setup();
    render(<UserList />);
    await screen.findByRole('link', { name: 'Sam Editor' });
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();

    await user.selectOptions(screen.getByLabelText('Type'), 'Account');
    expect(await screen.findByRole('link', { name: 'Ada Account' })).toBeVisible();
    expect(window.location.search).toBe('?role=Account');

    await user.selectOptions(screen.getByLabelText('Status'), 'disabled');
    expect(await screen.findByText('No users match these filters.')).toBeVisible();
    expect(window.location.search).toBe('?role=Account&disabled=true');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('link', { name: 'Sam Editor' })).toBeVisible();
    expect(window.location.search).toBe('');
    expect(screen.getByLabelText('Type')).toHaveValue('all');
    expect(screen.getByLabelText('Status')).toHaveValue('all');
    expect(api.calls('GET /api/v1/users?page=1&pageSize=20')).toHaveLength(1);
  });

  it('opens with the filters a shared link names', async () => {
    window.history.replaceState(null, '', '/admin/users?q=sam&role=Editor&disabled=false&page=3');
    const api = fakeFetch({
      'GET /api/v1/users?q=sam&role=Editor&disabled=false&page=3&pageSize=20': json(
        page([STAFF_USER], 3, 3),
      ),
    });
    render(<UserList />);

    expect(await screen.findByRole('link', { name: 'Sam Editor' })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: 'Name or email' })).toHaveValue('sam');
    expect(screen.getByLabelText('Type')).toHaveValue('Editor');
    expect(screen.getByLabelText('Status')).toHaveValue('enabled');
    expect(
      api.calls('GET /api/v1/users?q=sam&role=Editor&disabled=false&page=3&pageSize=20'),
    ).toHaveLength(1);
  });

  it('says so when there are no users at all', async () => {
    fakeFetch({ 'GET /api/v1/users?page=1&pageSize=20': json(page([])) });
    render(<UserList />);

    expect(await screen.findByText('No users here.')).toBeVisible();
  });
});

describe('readFilters and filterQuery', () => {
  it('ignore values the list does not offer', () => {
    expect(readFilters('?role=Owner&disabled=maybe&page=-1&q=%20%20')).toEqual({
      q: '',
      kind: 'all',
      enabled: 'all',
      page: 1,
    });
  });

  it('round-trip every filter, leaving out the defaults', () => {
    const filters = readFilters('?q=ada&role=Admin&disabled=true&page=4');
    expect(filters).toEqual({ q: 'ada', kind: 'Admin', enabled: 'disabled', page: 4 });
    expect(filterQuery(filters).toString()).toBe('q=ada&role=Admin&disabled=true&page=4');
    expect(filterQuery({ q: '', kind: 'all', enabled: 'all', page: 1 }).toString()).toBe('');
  });
});

describe('roleOf and userStatus', () => {
  it('give an Admin with both roles one role, and a user with none the account kind', () => {
    expect(roleOf({ roles: ['Admin', 'Editor'] })).toBe('Admin');
    expect(roleOf({ roles: ['Editor'] })).toBe('Editor');
    expect(roleOf({ roles: [] })).toBe('Account');
    expect(isStaffUser({ roles: [] })).toBe(false);
    expect(isStaffUser({ roles: ['Editor'] })).toBe(true);
  });

  it('call unconfirmed staff invited and an unconfirmed account unverified, with disabled first', () => {
    expect(userStatus({ ...STAFF_USER, emailConfirmed: false })).toBe('invited');
    expect(userStatus({ ...account, emailConfirmed: false })).toBe('unverified');
    expect(userStatus({ ...account, emailConfirmed: false, disabled: true })).toBe('disabled');
    expect(userStatus(account)).toBe('active');
  });
});

describe('InviteForm', () => {
  it('invites the user and hands over the one-time link to copy', async () => {
    const api = fakeFetch({
      'POST /api/v1/users': json({ user: invited, setupLink: SETUP_LINK }, { status: 201 }),
    });
    const user = userEvent.setup();
    render(<InviteForm />);

    await user.type(screen.getByLabelText('Email'), 'new@runovahq.com');
    await user.type(screen.getByLabelText('Name'), 'New Person');
    await user.selectOptions(screen.getByLabelText('Role'), 'Admin');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(await screen.findByLabelText('Invitation link')).toHaveValue(SETUP_LINK.url);
    expect(screen.getByRole('button', { name: 'Copy invitation link' })).toBeVisible();
    expect(screen.getByText(/works once/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open New Person' })).toHaveAttribute(
      'href',
      '/admin/users/8',
    );
    expect(api.calls('POST /api/v1/users')[0].json()).toEqual({
      email: 'new@runovahq.com',
      displayName: 'New Person',
      roles: ['Admin'],
    });
  });

  it('shows a taken email under the field', async () => {
    fakeFetch({
      'POST /api/v1/users': problem(409, 'conflict', {
        detail: 'A user with this email already exists.',
      }),
    });
    const user = userEvent.setup();
    render(<InviteForm />);

    await user.type(screen.getByLabelText('Email'), 'editor@runovahq.com');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A user with this email already exists.',
    );
  });
});

describe('UserEditor', () => {
  it('changes the role with a merge patch against the loaded version', async () => {
    const api = fakeFetch({
      'GET /api/v1/users/7': json(STAFF_USER, etag('1234')),
      'PATCH /api/v1/users/7': json({ ...STAFF_USER, roles: ['Admin'], version: '1235' }),
    });
    const user = userEvent.setup();
    render(<UserEditor id={7} />);

    await user.selectOptions(await screen.findByLabelText('Role'), 'Admin');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeVisible();
    const [patch] = api.calls('PATCH /api/v1/users/7');
    expect(patch.headers.get('if-match')).toBe('"1234"');
    expect(patch.json()).toEqual({ displayName: 'Sam Editor', roles: ['Admin'] });
  });

  it('gives a Runova account no role to pick, so saving its name never makes it staff', async () => {
    const api = fakeFetch({
      'GET /api/v1/users/12': json(account, etag('77')),
      'PATCH /api/v1/users/12': json({ ...account, displayName: 'Ada Lovelace', version: '78' }),
    });
    const user = userEvent.setup();
    render(<UserEditor id={12} />);

    const name = await screen.findByLabelText('Name');
    expect(screen.queryByLabelText('Role')).toBeNull();
    const details = screen.getByRole('region', { name: 'Account' });
    expect(within(details).getByText('Runova account')).toBeVisible();
    await user.clear(name);
    await user.type(name, 'Ada Lovelace');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeVisible();
    const [patch] = api.calls('PATCH /api/v1/users/12');
    expect(patch.headers.get('if-match')).toBe('"77"');
    expect(patch.json()).toEqual({ displayName: 'Ada Lovelace' });
  });

  it('shows a staff user as their role in the account details', async () => {
    fakeFetch({ 'GET /api/v1/users/7': json(STAFF_USER, etag('1234')) });
    render(<UserEditor id={7} />);

    const details = await screen.findByRole('region', { name: 'Account' });
    expect(within(details).getByText('Editor')).toBeVisible();
    expect(screen.getByLabelText('Role')).toHaveValue('Editor');
  });

  it('disables the account only after a confirmation', async () => {
    const api = fakeFetch({
      'GET /api/v1/users/7': json(STAFF_USER, etag('1234')),
      'PATCH /api/v1/users/7': json({ ...STAFF_USER, disabled: true, version: '1235' }),
    });
    const user = userEvent.setup();
    render(<UserEditor id={7} />);

    await user.click(await screen.findByRole('button', { name: 'Disable account' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Disable Sam Editor?' });
    expect(confirm).toHaveTextContent(/signed out/);
    expect(api.calls('PATCH /api/v1/users/7')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Disable' }));

    expect(await screen.findByRole('button', { name: 'Enable account' })).toBeVisible();
    expect(api.calls('PATCH /api/v1/users/7')[0].json()).toEqual({ disabled: true });
  });

  it('shows the last-Admin refusal from the API', async () => {
    const admin = { ...STAFF_USER, roles: ['Admin'] };
    fakeFetch({
      'GET /api/v1/users/7': json(admin, etag('1234')),
      'PATCH /api/v1/users/7': problem(409, 'conflict', {
        detail: 'The site needs at least one Admin.',
      }),
    });
    const user = userEvent.setup();
    render(<UserEditor id={7} />);

    await user.click(await screen.findByRole('button', { name: 'Disable account' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disable' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The site needs at least one Admin.',
    );
  });

  it('resets two-factor after a confirmation', async () => {
    const api = fakeFetch({
      'GET /api/v1/users/7': [
        json(STAFF_USER, etag('1234')),
        json({ ...STAFF_USER, twoFactorEnabled: false, version: '1235' }, etag('1235')),
      ],
      'DELETE /api/v1/users/7/two-factor': new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<UserEditor id={7} />);

    await user.click(await screen.findByRole('button', { name: 'Reset two-factor' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Reset two-factor for Sam Editor?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));

    expect(await screen.findByText('Two-factor sign-in is off.')).toBeVisible();
    expect(api.calls('DELETE /api/v1/users/7/two-factor')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Reset two-factor' })).toBeNull();
  });

  it('makes a new invitation link for someone who has not accepted yet', async () => {
    fakeFetch({
      'GET /api/v1/users/8': json(invited, etag('1234')),
      'POST /api/v1/users/8/invitations': json(SETUP_LINK, { status: 201 }),
    });
    const user = userEvent.setup();
    render(<UserEditor id={8} />);

    await user.click(await screen.findByRole('button', { name: 'New invitation link' }));

    expect(await screen.findByLabelText('Invitation link')).toHaveValue(SETUP_LINK.url);
    expect(screen.queryByRole('button', { name: 'Password reset link' })).toBeNull();
  });

  it('makes a password reset link for someone who has', async () => {
    fakeFetch({
      'GET /api/v1/users/7': json(STAFF_USER, etag('1234')),
      'POST /api/v1/users/7/password-resets': json(SETUP_LINK, { status: 201 }),
    });
    const user = userEvent.setup();
    render(<UserEditor id={7} />);

    await user.click(await screen.findByRole('button', { name: 'Password reset link' }));

    expect(await screen.findByLabelText('Password reset link')).toHaveValue(SETUP_LINK.url);
  });
});

describe('SetPasswordForm', () => {
  const TOKEN = 'dG9rZW4tZm9yLXRlc3RzLW9ubHktMzItYnl0ZXMtbG9uZw';

  beforeEach(() => {
    window.history.replaceState(null, '', `/admin/set-password#token=${TOKEN}`);
  });

  it('takes the token from the link, out of the address, and sets the password', async () => {
    const api = fakeFetch({
      'POST /api/v1/password-setups': new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<SetPasswordForm />);
    expect(window.location.hash).toBe('');

    await user.type(screen.getByLabelText('New password'), 'a long enough password');
    await user.type(screen.getByLabelText('Repeat the password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByText('Your password is set.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/admin/sign-in');
    expect(api.calls('POST /api/v1/password-setups')[0].json()).toEqual({
      token: TOKEN,
      password: 'a long enough password',
    });
  });

  it('refuses two passwords that differ without asking the API', async () => {
    const api = fakeFetch({});
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText('New password'), 'a long enough password');
    await user.type(screen.getByLabelText('Repeat the password'), 'a different password');
    await user.click(screen.getByRole('button', { name: 'Set password' }));

    expect(screen.getByText('The two passwords are not the same.')).toBeVisible();
    expect(api.calls('POST /api/v1/password-setups')).toHaveLength(0);
  });

  it('says the link is used up when the API no longer knows the token', async () => {
    fakeFetch({ 'POST /api/v1/password-setups': problem(404, 'not-found') });
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText('New password'), 'a long enough password');
    await user.type(screen.getByLabelText('Repeat the password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already used or has expired/);
  });

  it('asks for the link when the page is opened without one', () => {
    window.history.replaceState(null, '', '/admin/set-password');
    render(<SetPasswordForm />);

    expect(screen.getByText(/Open the link you were sent/)).toBeVisible();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });
});
