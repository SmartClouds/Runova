// @vitest-environment jsdom
import './setup/dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import Security from '../src/components/account/Security';
import type { Account } from '../src/lib/account/api';
import { fakeFetch, json } from './helpers/fakeAdminFetch';

const ME: Account = {
  id: 42,
  email: 'sam@example.com',
  displayName: 'Sam',
  emailConfirmed: true,
  hasPassword: true,
  twoFactorEnabled: false,
  logins: [],
  staff: false,
  createdAt: '2026-11-05T08:00:00.000Z',
  lastSignInAt: null,
  version: '3',
};

function routes(account: Account, providers: string[]) {
  return {
    'GET /api/v1/accounts/me': json(account),
    'GET /api/v1/users/me/two-factor': json({ enabled: false, recoveryCodesLeft: 0 }),
    'GET /api/v1/sign-in-providers': json({ items: providers, captcha: null }),
  };
}

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/account/security');
});

describe('Security, the Google card', () => {
  it('offers to link Google while the site has it on', async () => {
    fakeFetch(routes(ME, ['google']));
    render(<Security />);

    expect(await screen.findByRole('link', { name: 'Link Google' })).toHaveAttribute(
      'href',
      '/api/v1/external-sign-ins/google?link=true&returnUrl=%2Faccount%2Fsecurity',
    );
  });

  it('offers no link while an Admin has Google off', async () => {
    fakeFetch(routes(ME, []));
    render(<Security />);

    await screen.findByRole('heading', { name: /Password/ });
    expect(screen.queryByRole('link', { name: 'Link Google' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Sign in with your Google account as well as your password.'),
    ).not.toBeInTheDocument();
  });

  it('still lets a linked account unlink Google while it is off', async () => {
    fakeFetch(routes({ ...ME, logins: ['google'] }, []));
    render(<Security />);

    expect(await screen.findByRole('button', { name: 'Unlink' })).toBeInTheDocument();
  });
});
