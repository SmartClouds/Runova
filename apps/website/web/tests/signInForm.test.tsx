// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignInForm from '../src/components/admin/SignInForm';
import SignOutButton from '../src/components/admin/SignOutButton';
import { fakeFetch, problem } from './helpers/fakeAdminFetch';

const noContent = () => new Response(null, { status: 204 });
const needsCode = (detail = 'Enter the code from your authenticator app, or a recovery code.') =>
  problem(401, 'two-factor-required', { title: 'A second factor is needed.', detail });

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/admin/sign-in?next=%2Fadmin%2Fnews');
});

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'sam@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('SignInForm', () => {
  it('asks for the TOTP code after the password, then goes to the next page', async () => {
    const api = fakeFetch({ 'POST /api/v1/sessions': [needsCode(), noContent()] });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignInForm navigate={navigate} />);

    await signIn(user);
    const code = await screen.findByLabelText('Authentication code');
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/news'));
    const [first, second] = api.calls('POST /api/v1/sessions');
    expect(first.headers.get('x-xsrf-token')).toBe('xsrf');
    expect(first.json()).toEqual({
      email: 'sam@example.com',
      password: 'correct horse battery',
      twoFactorCode: null,
      recoveryCode: null,
    });
    expect(second.json()).toEqual({
      email: 'sam@example.com',
      password: 'correct horse battery',
      twoFactorCode: '123456',
      recoveryCode: null,
    });
  });

  it('shows a wrong code next to the code field', async () => {
    fakeFetch({
      'POST /api/v1/sessions': [
        needsCode(),
        needsCode('The code is not right or was already used.'),
      ],
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignInForm navigate={navigate} />);
    await signIn(user);
    await user.type(await screen.findByLabelText('Authentication code'), '000000');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const code = screen.getByLabelText('Authentication code');
    await waitFor(() => expect(code).toHaveAttribute('aria-invalid', 'true'));
    expect(code).toHaveAccessibleDescription(
      expect.stringContaining('The code is not right or was already used.'),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('takes a recovery code instead of the TOTP code', async () => {
    const api = fakeFetch({ 'POST /api/v1/sessions': [needsCode(), noContent()] });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignInForm navigate={navigate} />);
    await signIn(user);
    await screen.findByLabelText('Authentication code');

    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    const recovery = screen.getByLabelText('Recovery code');
    expect(recovery).toHaveFocus();
    await user.type(recovery, 'ab12c-34def');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.calls('POST /api/v1/sessions')[1].json()).toMatchObject({
      twoFactorCode: null,
      recoveryCode: 'ab12c-34def',
    });
  });

  it('says when the email or password is wrong, and never follows a next URL off the admin area', async () => {
    window.history.replaceState(null, '', '/admin/sign-in?next=https%3A%2F%2Fevil.example%2F');
    fakeFetch({
      'POST /api/v1/sessions': [
        problem(401, 'unauthorized', { detail: 'The email or password is not right.' }),
        noContent(),
      ],
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignInForm navigate={navigate} />);

    await signIn(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The email or password is not right.');
    expect(alert).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin'));
  });

  it('says how long a locked account stays locked', async () => {
    fakeFetch({
      'POST /api/v1/sessions': problem(423, 'account-locked', {
        detail: 'Too many failed sign-ins.',
        retryAfter: 600,
      }),
    });
    const user = userEvent.setup();
    render(<SignInForm navigate={vi.fn()} />);

    await signIn(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many failed sign-ins. Try again in 10 minutes.',
    );
  });

  it('shows field errors next to their fields', async () => {
    fakeFetch({
      'POST /api/v1/sessions': problem(400, 'validation-failed', {
        errors: { email: ['Enter an email.'] },
      }),
    });
    const user = userEvent.setup();
    render(<SignInForm navigate={vi.fn()} />);

    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const email = screen.getByLabelText('Email');
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(email).toHaveAccessibleDescription('Enter an email.');
  });
});

describe('SignOutButton', () => {
  it('ends the session with the antiforgery header and goes to sign-in', async () => {
    const api = fakeFetch({ 'DELETE /api/v1/sessions/current': noContent() });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignOutButton navigate={navigate} />);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/sign-in'));
    expect(api.calls('DELETE /api/v1/sessions/current')[0].headers.get('x-xsrf-token')).toBe(
      'xsrf',
    );
  });

  it('says so when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignOutButton navigate={navigate} />);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached');
    expect(navigate).not.toHaveBeenCalled();
  });
});
