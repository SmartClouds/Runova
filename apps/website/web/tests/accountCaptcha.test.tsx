// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgotPassword, Register, SignIn } from '../src/components/account/AuthForms';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';
import { captchaOn, fakeTurnstile } from './helpers/fakeTurnstile';

const noContent = () => new Response(null, { status: 204 });
const accepted = () => new Response(null, { status: 202 });
const withCaptcha = () => json({ items: [], captcha: captchaOn });
const captchaRefused = () =>
  problem(400, 'validation-failed', {
    errors: { captchaToken: ['Complete the check that you are a person, then try again.'] },
  });

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/account/sign-in');
});

async function typeCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'sam@example.com');
  await user.type(screen.getByLabelText(/^Password/), 'correct horse battery');
}

describe('SignIn with the captcha on', () => {
  it('waits for the check, then sends its token with the sign-in', async () => {
    const turnstile = fakeTurnstile();
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/sessions': noContent(),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignIn navigate={navigate} />);
    await typeCredentials(user);
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /Sign in/ })).toBeDisabled();
    turnstile.solve('tok-sign-in', 'sign-in');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/account'));
    expect(api.calls('POST /api/v1/sessions')[0]?.json()).toMatchObject({
      email: 'sam@example.com',
      captchaToken: 'tok-sign-in',
    });
  });

  it('starts a fresh check for the two-factor step, since a token works once', async () => {
    const turnstile = fakeTurnstile();
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/sessions': [problem(401, 'two-factor-required'), noContent()],
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignIn navigate={navigate} />);
    await typeCredentials(user);
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-1', 'sign-in');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    await user.type(await screen.findByLabelText('Code'), '123456');
    expect(turnstile.api.reset).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeDisabled();
    turnstile.solve('tok-2', 'sign-in');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.calls('POST /api/v1/sessions')[1]?.json()).toMatchObject({
      twoFactorCode: '123456',
      captchaToken: 'tok-2',
    });
  });

  it('shows a refused check under the widget', async () => {
    const turnstile = fakeTurnstile();
    fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/sessions': captchaRefused(),
    });
    const user = userEvent.setup();
    render(<SignIn />);
    await typeCredentials(user);
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-1', 'sign-in');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    expect(await screen.findByText(/Complete the check that you are a person/)).toBeInTheDocument();
    expect(screen.queryByText('One or more fields are not valid.')).not.toBeInTheDocument();
  });

  it('gives the new confirmation link a check of its own', async () => {
    const turnstile = fakeTurnstile();
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/sessions': problem(403, 'email-unverified'),
      'POST /api/v1/verification-emails': accepted(),
    });
    const user = userEvent.setup();
    render(<SignIn />);
    await typeCredentials(user);
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-1', 'sign-in');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    const resend = await screen.findByRole('button', { name: 'Send a new link' });
    await waitFor(() => turnstile.widget('verification-email'));
    expect(resend).toBeDisabled();
    turnstile.solve('tok-resend', 'verification-email');
    await user.click(resend);

    expect(await screen.findByText(/A new link is on its way/)).toBeInTheDocument();
    expect(api.calls('POST /api/v1/verification-emails')[0]?.json()).toEqual({
      email: 'sam@example.com',
      captchaToken: 'tok-resend',
    });
  });

  it('needs no check for the code step after Google', async () => {
    const turnstile = fakeTurnstile();
    fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/two-factor-sign-ins': noContent(),
    });
    window.history.replaceState(null, '', '/account/sign-in?step=two-factor');
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignIn navigate={navigate} />);

    await user.type(screen.getByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(turnstile.api.render).not.toHaveBeenCalled();
  });
});

describe('SignIn with the captcha off', () => {
  it('shows no widget and sends no token', async () => {
    const turnstile = fakeTurnstile();
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': json({ items: [], captcha: null }),
      'POST /api/v1/sessions': noContent(),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignIn navigate={navigate} />);
    await typeCredentials(user);
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(turnstile.api.render).not.toHaveBeenCalled();
    expect(api.calls('POST /api/v1/sessions')[0]?.json()).not.toHaveProperty('captchaToken');
  });
});

describe('Register with the captcha on', () => {
  it('sends the token for the sign-up, and checks again before sending the link again', async () => {
    const turnstile = fakeTurnstile();
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/accounts': accepted(),
      'POST /api/v1/verification-emails': accepted(),
    });
    const user = userEvent.setup();
    render(<Register />);
    await user.type(screen.getByLabelText('Your name'), 'Sam');
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Make account' })).toBeDisabled();
    turnstile.solve('tok-register', 'register');
    await user.click(screen.getByRole('button', { name: 'Make account' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(api.calls('POST /api/v1/accounts')[0]?.json()).toEqual({
      email: 'sam@example.com',
      password: 'correct horse battery',
      displayName: 'Sam',
      captchaToken: 'tok-register',
    });

    await waitFor(() => turnstile.widget('verification-email'));
    turnstile.solve('tok-again', 'verification-email');
    await user.click(screen.getByRole('button', { name: 'send it again' }));

    await waitFor(() =>
      expect(api.calls('POST /api/v1/verification-emails')[0]?.json()).toEqual({
        email: 'sam@example.com',
        captchaToken: 'tok-again',
      }),
    );
  });

  it('shows a refused check under the widget, not as a page error', async () => {
    const turnstile = fakeTurnstile();
    fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/accounts': captchaRefused(),
    });
    const user = userEvent.setup();
    render(<Register />);
    await user.type(screen.getByLabelText('Your name'), 'Sam');
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-1', 'register');
    await user.click(screen.getByRole('button', { name: 'Make account' }));

    expect(await screen.findByText(/Complete the check that you are a person/)).toBeInTheDocument();
    expect(turnstile.api.reset).toHaveBeenCalled();
  });
});

describe('ForgotPassword with the captcha on', () => {
  it('sends the token for a reset link', async () => {
    const turnstile = fakeTurnstile();
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/password-resets': accepted(),
    });
    const user = userEvent.setup();
    render(<ForgotPassword />);
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-reset', 'password-reset');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(api.calls('POST /api/v1/password-resets')[0]?.json()).toEqual({
      email: 'sam@example.com',
      captchaToken: 'tok-reset',
    });
  });

  it('shows a refused check under the widget', async () => {
    const turnstile = fakeTurnstile();
    fakeFetch({
      'GET /api/v1/sign-in-providers': withCaptcha(),
      'POST /api/v1/password-resets': captchaRefused(),
    });
    const user = userEvent.setup();
    render(<ForgotPassword />);
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-1', 'password-reset');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    expect(await screen.findByText(/Complete the check that you are a person/)).toBeInTheDocument();
  });
});
