// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Security from '../src/components/account/Security';
import type { Account } from '../src/lib/account/api';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

// jsdom can not navigate, so the hop to the provider is only recorded.
const goToProvider = vi.hoisted(() => vi.fn());
vi.mock('../src/components/account/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/account/providers')>()),
  goToProvider,
}));

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

const openDialog = () => document.querySelector<HTMLElement>('dialog[open]') as HTMLElement;

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/account/security');
  goToProvider.mockReset();
  // jsdom has no modal dialogs; these open and close one the way the browser does.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

describe('Security, Connected accounts', () => {
  it('offers to link each provider the site has on', async () => {
    fakeFetch(routes(ME, ['google', 'apple', 'microsoft']));
    render(<Security />);

    expect(await screen.findByRole('heading', { name: 'Connected accounts' })).toBeInTheDocument();
    for (const name of ['Google', 'Apple', 'Microsoft']) {
      expect(screen.getByRole('button', { name: `Link ${name}` })).toBeInTheDocument();
    }
  });

  it('links a provider only after the password, then sends the browser there', async () => {
    const api = fakeFetch({
      ...routes(ME, ['google']),
      'POST /api/v1/accounts/me/login-link-grants': new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Link Google' }));
    const dialog = openDialog();
    expect(within(dialog).getByText('Link Google?')).toBeInTheDocument();
    expect(goToProvider).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('Your password'), 'correct horse battery');
    await user.click(within(dialog).getByRole('button', { name: 'Continue', hidden: true }));

    await waitFor(() =>
      expect(goToProvider).toHaveBeenCalledWith('google', '/account/security', true),
    );
    expect(api.calls('POST /api/v1/accounts/me/login-link-grants')[0]?.json()).toEqual({
      password: 'correct horse battery',
      code: null,
    });
  });

  it('stays put and says why when the proof is wrong', async () => {
    fakeFetch({
      ...routes(ME, ['google']),
      'POST /api/v1/accounts/me/login-link-grants': problem(400, 'validation-failed', {
        errors: { password: ['Enter your password to confirm.'] },
      }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Link Google' }));
    const dialog = openDialog();
    await user.type(within(dialog).getByLabelText('Your password'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Continue', hidden: true }));

    expect(await within(dialog).findByText('Enter your password to confirm.')).toBeInTheDocument();
    expect(goToProvider).not.toHaveBeenCalled();
  });

  it('says to confirm first when a link came back without the proof', async () => {
    window.history.replaceState(null, '', '/account/security?error=step-up-needed');
    fakeFetch(routes(ME, ['google']));
    render(<Security />);

    expect(
      await screen.findByText('Confirm it is you first, then try linking again.'),
    ).toBeInTheDocument();
  });

  it('shows nothing while an Admin has every provider off', async () => {
    fakeFetch(routes(ME, []));
    render(<Security />);

    await screen.findByRole('heading', { name: /Password/ });
    expect(screen.queryByRole('heading', { name: 'Connected accounts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Link / })).not.toBeInTheDocument();
  });

  it('still lets a linked account unlink a provider while it is off', async () => {
    const api = fakeFetch({
      ...routes({ ...ME, logins: ['apple'] }, ['google']),
      'DELETE /api/v1/accounts/me/logins/apple': new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<Security />);

    const apple = within(await screen.findByRole('listitem', { name: 'Apple' }));
    expect(apple.getByText('Linked')).toBeInTheDocument();
    await user.click(apple.getByRole('button', { name: 'Unlink Apple' }));

    await waitFor(() =>
      expect(api.calls('DELETE /api/v1/accounts/me/logins/apple')).toHaveLength(1),
    );
    expect(screen.getByRole('button', { name: 'Link Google' })).toBeInTheDocument();
  });

  it('says why the last way in can not be unlinked', async () => {
    fakeFetch({
      ...routes({ ...ME, hasPassword: false, logins: ['microsoft'] }, ['microsoft']),
      'DELETE /api/v1/accounts/me/logins/microsoft': problem(409, 'conflict', {
        detail: 'This is your only way to sign in. Set a password first, then unlink it.',
      }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Unlink Microsoft' }));

    expect(await screen.findByText(/This is your only way to sign in/)).toBeInTheDocument();
  });

  it('says a provider was linked when the browser comes back', async () => {
    window.history.replaceState(null, '', '/account/security?linked=microsoft');
    fakeFetch(routes({ ...ME, logins: ['microsoft'] }, ['microsoft']));
    render(<Security />);

    expect(
      await screen.findByText('Microsoft is linked. You can sign in with it from now on.'),
    ).toBeInTheDocument();
  });

  it('names the provider a password-less account signs in with', async () => {
    fakeFetch(routes({ ...ME, hasPassword: false, logins: ['apple'] }, ['apple']));
    render(<Security />);

    expect(await screen.findByText(/You sign in with Apple\./)).toBeInTheDocument();
  });
});

describe('Security, turning two-factor on', () => {
  const setup = () =>
    json({ sharedKey: 'JBSWY3DPEHPK3PXP', authenticatorUri: 'otpauth://totp/Runova:sam' });

  it('asks for the password after the code, and sends both', async () => {
    const api = fakeFetch({
      ...routes(ME, []),
      'POST /api/v1/users/me/two-factor': setup(),
      'PUT /api/v1/users/me/two-factor': json({ recoveryCodes: ['aaaa-1111', 'bbbb-2222'] }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Turn on' }));
    await user.type(await screen.findByLabelText('Code'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }));
    const dialog = openDialog();
    expect(api.calls('PUT /api/v1/users/me/two-factor')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Your password'), 'correct horse battery');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on', hidden: true }));

    expect(await screen.findByText('aaaa-1111')).toBeInTheDocument();
    expect(api.calls('PUT /api/v1/users/me/two-factor')[0]?.json()).toEqual({
      password: 'correct horse battery',
      code: '123456',
    });
  });

  it('puts a wrong authenticator code under the code field', async () => {
    fakeFetch({
      ...routes(ME, []),
      'POST /api/v1/users/me/two-factor': setup(),
      'PUT /api/v1/users/me/two-factor': problem(400, 'validation-failed', {
        errors: { code: ['The code is not right. Enter the current code from your app.'] },
      }),
    });
    const user = userEvent.setup();
    render(<Security />);

    await user.click(await screen.findByRole('button', { name: 'Turn on' }));
    await user.type(await screen.findByLabelText('Code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }));
    await user.type(within(openDialog()).getByLabelText('Your password'), 'correct horse battery');
    await user.click(within(openDialog()).getByRole('button', { name: 'Turn on', hidden: true }));

    expect(await screen.findByText(/The code is not right/)).toBeInTheDocument();
    expect(document.querySelector('dialog[open]')).toBeNull();
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
