// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Security from '../src/components/account/Security';
import type { Account } from '../src/lib/account/api';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const ME: Account = {
  id: 42,
  email: 'sam@example.com',
  displayName: 'Sam',
  emailConfirmed: true,
  hasPassword: true,
  twoFactorEnabled: false,
  logins: [],
  passkeyCount: 0,
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
    'GET /api/v1/users/me/passkeys': json({ items: [] }),
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

describe('Security, the Passkeys card', () => {
  const LAPTOP = {
    id: 'AQI',
    name: 'Work laptop',
    createdAt: '2026-11-19T08:00:00.000Z',
    synced: true,
  };
  const attestation = {
    id: 'AQI',
    rawId: new Uint8Array([1, 2]).buffer,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: new Uint8Array([3]).buffer,
      attestationObject: new Uint8Array([4]).buffer,
      getTransports: () => ['internal'],
    },
  };
  const assertion = {
    id: 'AQI',
    rawId: new Uint8Array([1, 2]).buffer,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: new Uint8Array([3]).buffer,
      authenticatorData: new Uint8Array([4]).buffer,
      signature: new Uint8Array([5]).buffer,
      userHandle: null,
    },
  };
  const challenge = (id: string) =>
    json(
      {
        id,
        options: {
          challenge: 'AQID',
          rp: { id: 'runovahq.com', name: 'Runova' },
          user: { id: 'NDI', name: 'sam', displayName: 'Sam' },
        },
        expiresAt: '',
      },
      { status: 201 },
    );

  function stubPasskeys(credentials: Partial<CredentialsContainer>) {
    vi.stubGlobal('PublicKeyCredential', class {});
    Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true });
  }

  const openDialog = () => document.querySelector<HTMLElement>('dialog[open]') as HTMLElement;

  // jsdom has no modal dialogs; these open and close one the way the browser does.
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
  });

  it('lists the passkeys on the account', async () => {
    fakeFetch({
      ...routes({ ...ME, passkeyCount: 1 }, []),
      'GET /api/v1/users/me/passkeys': json({ items: [LAPTOP] }),
    });
    render(<Security />);

    expect(await screen.findByText('Work laptop')).toBeInTheDocument();
    expect(screen.getByText(/Synced/)).toBeInTheDocument();
  });

  it('adds a passkey under the name given, after the password', async () => {
    stubPasskeys({ create: vi.fn().mockResolvedValue(attestation) });
    const api = fakeFetch({
      ...routes(ME, []),
      'GET /api/v1/users/me/passkeys': [json({ items: [] }), json({ items: [LAPTOP] })],
      'POST /api/v1/passkey-challenges': challenge('register-1'),
      'POST /api/v1/users/me/passkeys': json(LAPTOP, { status: 201 }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const dialog = openDialog();
    await user.type(within(dialog).getByLabelText('Name it'), 'Work laptop');
    await user.type(within(dialog).getByLabelText('Your password'), 'correct horse battery');
    await user.click(within(dialog).getByRole('button', { name: 'Add passkey', hidden: true }));

    await waitFor(() => expect(api.calls('POST /api/v1/users/me/passkeys')).toHaveLength(1));
    expect(api.calls('POST /api/v1/passkey-challenges')[0]?.json()).toEqual({
      purpose: 'register',
    });
    expect(api.calls('POST /api/v1/users/me/passkeys')[0]?.json()).toEqual({
      challengeId: 'register-1',
      credential: expect.objectContaining({ id: 'AQI' }),
      name: 'Work laptop',
      password: 'correct horse battery',
      code: null,
    });
    expect(await screen.findByText('Work laptop')).toBeInTheDocument();
  });

  it('shows the field error when the password is wrong', async () => {
    stubPasskeys({ create: vi.fn().mockResolvedValue(attestation) });
    fakeFetch({
      ...routes(ME, []),
      'POST /api/v1/passkey-challenges': challenge('register-1'),
      'POST /api/v1/users/me/passkeys': problem(400, 'validation-failed', {
        errors: { password: ['Enter your password to confirm.'] },
      }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const dialog = openDialog();
    await user.type(within(dialog).getByLabelText('Your password'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Add passkey', hidden: true }));

    expect(await within(dialog).findByText('Enter your password to confirm.')).toBeInTheDocument();
  });

  it('says this browser can not make one when it has no passkeys', async () => {
    fakeFetch(routes(ME, []));
    render(<Security />);

    expect(await screen.findByText(/This browser can not make passkeys/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).not.toBeInTheDocument();
  });

  it('renames a passkey', async () => {
    const api = fakeFetch({
      ...routes({ ...ME, passkeyCount: 1 }, []),
      'GET /api/v1/users/me/passkeys': [
        json({ items: [LAPTOP] }),
        json({ items: [{ ...LAPTOP, name: 'Phone' }] }),
      ],
      'PATCH /api/v1/users/me/passkeys/AQI': json({ ...LAPTOP, name: 'Phone' }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Rename Work laptop' }));
    const field = screen.getByLabelText('New name for Work laptop');
    await user.clear(field);
    await user.type(field, 'Phone{Enter}');

    await waitFor(() =>
      expect(api.calls('PATCH /api/v1/users/me/passkeys/AQI')[0]?.json()).toEqual({
        name: 'Phone',
      }),
    );
    expect(await screen.findByText('Phone')).toBeInTheDocument();
  });

  it('removes a passkey, confirmed with another passkey instead of the password', async () => {
    stubPasskeys({ get: vi.fn().mockResolvedValue(assertion) });
    const api = fakeFetch({
      ...routes({ ...ME, passkeyCount: 2 }, []),
      'GET /api/v1/users/me/passkeys': [json({ items: [LAPTOP] }), json({ items: [] })],
      'POST /api/v1/passkey-challenges': challenge('step-up-1'),
      'DELETE /api/v1/users/me/passkeys/AQI': new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Remove Work laptop' }));
    const dialog = openDialog();
    await user.click(
      within(dialog).getByRole('button', { name: 'Use a passkey instead', hidden: true }),
    );

    await waitFor(() => expect(api.calls('DELETE /api/v1/users/me/passkeys/AQI')).toHaveLength(1));
    expect(api.calls('POST /api/v1/passkey-challenges')[0]?.json()).toEqual({ purpose: 'step-up' });
    expect(api.calls('DELETE /api/v1/users/me/passkeys/AQI')[0]?.json()).toEqual({
      password: null,
      code: null,
      passkeyChallengeId: 'step-up-1',
      passkeyCredential: expect.objectContaining({ id: 'AQI' }),
    });
    await waitFor(() => expect(screen.queryByText('Work laptop')).not.toBeInTheDocument());
  });
});
