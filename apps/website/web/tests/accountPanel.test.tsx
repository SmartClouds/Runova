// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Register, SignIn } from '../src/components/account/AuthForms';
import AuthorizeDevice, { readAuthorizeRequest } from '../src/components/account/AuthorizeDevice';
import { ActivityList, describeActivity } from '../src/components/account/Panel';
import { groupByDay } from '../src/components/account/ui';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const noContent = () => new Response(null, { status: 204 });
const providers = (items: string[] = []) => json({ items });

const AUTHORIZE =
  '?client_id=runova-desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A53111%2Fcallback&response_type=code&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&code_challenge_method=S256&state=state-12345&device_name=Sam%27s%20MacBook&platform=macos&app_version=3.4.0&device_id=4b2c0c0e-1111-4222-8333-944444444444';

const PHONE_AUTHORIZE =
  '?client_id=runova-mobile&redirect_uri=com.runovahq.app%3A%2Fauth%2Fcallback&response_type=code&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&code_challenge_method=S256&state=state-12345&device_name=Sam%27s%20phone&platform=ios&app_version=1.0.0&device_id=4b2c0c0e-1111-4222-8333-944444444444';

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
});

describe('SignIn', () => {
  beforeEach(() =>
    window.history.replaceState(null, '', '/account/sign-in?next=%2Faccount%2Fteams'),
  );

  it('signs in and goes on to the page it came for', async () => {
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': providers(),
      'POST /api/v1/sessions': noContent(),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignIn navigate={navigate} />);

    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/account/teams'));
    expect(api.calls('POST /api/v1/sessions')[0]?.headers.get('x-xsrf-token')).toBe('xsrf');
  });

  it('asks for the two-factor code when the account has it on', async () => {
    fakeFetch({
      'GET /api/v1/sign-in-providers': providers(),
      'POST /api/v1/sessions': [
        problem(401, 'two-factor-required', { detail: 'Enter the code.' }),
        noContent(),
      ],
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignIn navigate={navigate} />);

    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await user.type(await screen.findByLabelText('Code'), '123 456');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('offers a new confirmation link to an account whose email is not confirmed', async () => {
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': providers(),
      'POST /api/v1/sessions': problem(403, 'email-unverified', {
        detail: 'Confirm your email first.',
      }),
      'POST /api/v1/verification-emails': new Response(null, { status: 202 }),
    });
    const user = userEvent.setup();
    render(<SignIn />);

    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await user.click(await screen.findByRole('button', { name: 'Send a new link' }));

    expect(await screen.findByText(/A new link is on its way/)).toBeInTheDocument();
    expect(api.calls('POST /api/v1/verification-emails')[0]?.json()).toEqual({
      email: 'sam@example.com',
    });
  });

  it('shows Continue with Google only when the site has it', async () => {
    fakeFetch({ 'GET /api/v1/sign-in-providers': providers(['google']) });
    render(<SignIn />);

    const google = await screen.findByRole('link', { name: /Continue with Google/ });

    expect(google).toHaveAttribute(
      'href',
      '/api/v1/external-sign-ins/google?returnUrl=%2Faccount%2Fteams',
    );
  });

  it('explains why a provider could not link by email', async () => {
    fakeFetch({ 'GET /api/v1/sign-in-providers': providers(['google']) });
    window.history.replaceState(null, '', '/account/sign-in?error=link-needed');
    render(<SignIn />);

    expect(screen.getByText(/then link it under Security/)).toBeInTheDocument();
  });

  it('offers Google, Apple and Microsoft in the order the site lists them', async () => {
    fakeFetch({ 'GET /api/v1/sign-in-providers': providers(['google', 'apple', 'microsoft']) });
    render(<SignIn />);

    const links = await screen.findAllByRole('link', { name: /^Continue with / });

    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Continue with Google', '/api/v1/external-sign-ins/google?returnUrl=%2Faccount%2Fteams'],
      ['Continue with Apple', '/api/v1/external-sign-ins/apple?returnUrl=%2Faccount%2Fteams'],
      [
        'Continue with Microsoft',
        '/api/v1/external-sign-ins/microsoft?returnUrl=%2Faccount%2Fteams',
      ],
    ]);
  });

  it('offers only the providers the site has', async () => {
    fakeFetch({ 'GET /api/v1/sign-in-providers': providers(['microsoft', 'something-new']) });
    render(<SignIn />);

    expect(
      await screen.findByRole('link', { name: 'Continue with Microsoft' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Continue with / })).toHaveLength(1);
  });

  it.each([
    ['apple-failed', 'Apple did not finish signing you in. Try again.'],
    ['microsoft-failed', 'Microsoft did not finish signing you in. Try again.'],
    ['google-failed', 'Google did not finish signing you in. Try again.'],
  ])('says what went wrong for %s', async (error, message) => {
    fakeFetch({ 'GET /api/v1/sign-in-providers': providers(['google', 'apple', 'microsoft']) });
    window.history.replaceState(null, '', `/account/sign-in?error=${error}`);
    render(<SignIn />);

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('keeps where a failed provider sign-in was going', async () => {
    fakeFetch({ 'GET /api/v1/sign-in-providers': providers(['apple']) });
    window.history.replaceState(
      null,
      '',
      `/account/sign-in?error=apple-failed&next=${encodeURIComponent('/account/authorize?client_id=runova-mobile')}`,
    );
    render(<SignIn />);

    expect(await screen.findByRole('link', { name: 'Continue with Apple' })).toHaveAttribute(
      'href',
      `/api/v1/external-sign-ins/apple?returnUrl=${encodeURIComponent('/account/authorize?client_id=runova-mobile')}`,
    );
  });
});

describe('SignIn with a passkey', () => {
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
      userHandle: new Uint8Array([0x34, 0x32]).buffer,
    },
  };
  const challenge = () =>
    json(
      { id: 'challenge-1', options: { challenge: 'AQID', rpId: 'runovahq.com' }, expiresAt: '' },
      { status: 201 },
    );

  function stubPasskeys(get: () => Promise<unknown>) {
    vi.stubGlobal('PublicKeyCredential', class {});
    Object.defineProperty(navigator, 'credentials', { value: { get }, configurable: true });
  }

  beforeEach(() =>
    window.history.replaceState(null, '', '/account/sign-in?next=%2Faccount%2Fteams'),
  );

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
  });

  it('signs in with the passkey the browser offers, with no email or password', async () => {
    stubPasskeys(vi.fn().mockResolvedValue(assertion));
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': providers(),
      'POST /api/v1/passkey-challenges': challenge(),
      'POST /api/v1/passkey-sign-ins': noContent(),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignIn navigate={navigate} />);

    await user.click(screen.getByRole('button', { name: 'Use a passkey' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/account/teams'));
    expect(api.calls('POST /api/v1/passkey-sign-ins')[0]?.json()).toEqual({
      challengeId: 'challenge-1',
      credential: expect.objectContaining({ id: 'AQI', rawId: 'AQI' }),
    });
    expect(api.calls('POST /api/v1/sessions')).toHaveLength(0);
  });

  it('says so when the site does not accept the passkey', async () => {
    stubPasskeys(vi.fn().mockResolvedValue(assertion));
    fakeFetch({
      'GET /api/v1/sign-in-providers': providers(),
      'POST /api/v1/passkey-challenges': challenge(),
      'POST /api/v1/passkey-sign-ins': problem(401, 'unauthorized', {
        detail: 'That passkey was not accepted.',
      }),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SignIn navigate={navigate} />);

    await user.click(screen.getByRole('button', { name: 'Use a passkey' }));

    expect(await screen.findByText('That passkey was not accepted.')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows nothing when the person closes the passkey prompt', async () => {
    stubPasskeys(vi.fn().mockRejectedValue(new DOMException('closed', 'NotAllowedError')));
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': providers(),
      'POST /api/v1/passkey-challenges': challenge(),
    });
    const user = userEvent.setup();
    render(<SignIn />);

    await user.click(screen.getByRole('button', { name: 'Use a passkey' }));

    await waitFor(() => expect(api.calls('POST /api/v1/passkey-challenges')).toHaveLength(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a passkey' })).toBeEnabled();
  });

  it('offers no passkey in a browser that has none', async () => {
    fakeFetch({ 'GET /api/v1/sign-in-providers': providers() });
    render(<SignIn />);

    await screen.findByLabelText('Email');
    expect(screen.queryByRole('button', { name: 'Use a passkey' })).not.toBeInTheDocument();
  });
});

describe('Register', () => {
  it('offers to make the account with Google, Apple or Microsoft instead', async () => {
    fakeFetch({ 'GET /api/v1/sign-in-providers': providers(['google', 'apple', 'microsoft']) });
    render(<Register />);

    expect(await screen.findByRole('link', { name: 'Continue with Apple' })).toHaveAttribute(
      'href',
      '/api/v1/external-sign-ins/apple?returnUrl=%2Faccount',
    );
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with Microsoft' })).toBeInTheDocument();
  });

  it('says to check the email once the account is made', async () => {
    const api = fakeFetch({
      'GET /api/v1/sign-in-providers': providers(),
      'POST /api/v1/accounts': new Response(null, { status: 202 }),
    });
    const user = userEvent.setup();
    render(<Register />);

    await user.type(screen.getByLabelText('Your name'), 'Sam');
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Make account' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(api.calls('POST /api/v1/accounts')[0]?.json()).toEqual({
      email: 'sam@example.com',
      password: 'correct horse battery',
      displayName: 'Sam',
    });
  });

  it('shows the field the API refused under that field', async () => {
    fakeFetch({
      'GET /api/v1/sign-in-providers': providers(),
      'POST /api/v1/accounts': problem(400, 'validation-failed', {
        errors: { password: ['Use at least 12 characters.'] },
      }),
    });
    const user = userEvent.setup();
    render(<Register />);

    await user.type(screen.getByLabelText('Your name'), 'Sam');
    await user.type(screen.getByLabelText('Email'), 'sam@example.com');
    await user.type(screen.getByLabelText('Password'), 'twelve chars');
    await user.click(screen.getByRole('button', { name: 'Make account' }));

    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
  });
});

describe('AuthorizeDevice', () => {
  it('reads a desktop sign-in link and refuses anything else', () => {
    expect(readAuthorizeRequest(AUTHORIZE)?.deviceName).toBe("Sam's MacBook");
    expect(readAuthorizeRequest(AUTHORIZE.replace('runova-desktop', 'evil'))).toBeNull();
    expect(readAuthorizeRequest(AUTHORIZE.replace('127.0.0.1', 'evil.example'))).toBeNull();
  });

  it('reads a phone sign-in link only with the phone redirect', () => {
    expect(readAuthorizeRequest(PHONE_AUTHORIZE)?.clientId).toBe('runova-mobile');
    expect(
      readAuthorizeRequest(PHONE_AUTHORIZE.replace('com.runovahq.app', 'com.other.app')),
    ).toBeNull();
    expect(
      readAuthorizeRequest(
        PHONE_AUTHORIZE.replace(
          'com.runovahq.app%3A%2Fauth%2Fcallback',
          'http%3A%2F%2F127.0.0.1%3A53111%2Fcallback',
        ),
      ),
    ).toBeNull();
    expect(readAuthorizeRequest(AUTHORIZE.replace('runova-desktop', 'runova-mobile'))).toBeNull();
  });

  it('asks about the Runova app in generic words and sends the browser back to it', async () => {
    window.history.replaceState(null, '', `/account/authorize${PHONE_AUTHORIZE}`);
    const redirectUrl = 'com.runovahq.app:/auth/callback?code=c&state=state-12345';
    fakeFetch({
      'POST /api/v1/device-authorizations': json(
        { redirectUrl, expiresAt: '2026-11-05T10:00:00.000Z' },
        { status: 201 },
      ),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<AuthorizeDevice email="sam@example.com" navigate={navigate} />);

    expect(screen.getByRole('heading', { name: 'Sign in the Runova app?' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/iphone|ipad|android|ios app|mobile|phone/i);
    await user.click(screen.getByRole('button', { name: /Sign in the app/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(redirectUrl));
  });

  it('names the computer and the account, and approving sends the browser back to the app', async () => {
    window.history.replaceState(null, '', `/account/authorize${AUTHORIZE}`);
    const api = fakeFetch({
      'POST /api/v1/device-authorizations': json(
        {
          redirectUrl: 'http://127.0.0.1:53111/callback?code=c&state=state-12345',
          expiresAt: '2026-11-05T10:00:00.000Z',
        },
        { status: 201 },
      ),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<AuthorizeDevice email="sam@example.com" navigate={navigate} />);

    expect(
      screen.getByRole('heading', { name: "Sign in Runova on Sam's MacBook?" }),
    ).toBeInTheDocument();
    expect(screen.getByText('sam@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sign in this computer/ }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        'http://127.0.0.1:53111/callback?code=c&state=state-12345',
      ),
    );
    expect(api.calls('POST /api/v1/device-authorizations')[0]?.json()).toMatchObject({
      clientId: 'runova-desktop',
      platform: 'macos',
      deviceName: "Sam's MacBook",
      state: 'state-12345',
    });
  });

  it('tells the app no when the person declines', async () => {
    window.history.replaceState(null, '', `/account/authorize${AUTHORIZE}`);
    fakeFetch({});
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<AuthorizeDevice email="sam@example.com" navigate={navigate} />);

    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(navigate).toHaveBeenCalledWith(
      'http://127.0.0.1:53111/callback?error=access_denied&state=state-12345',
    );
  });

  it('turns away a link that did not come from the app', () => {
    window.history.replaceState(null, '', '/account/authorize?client_id=evil');
    render(<AuthorizeDevice email="sam@example.com" />);

    expect(
      screen.getByRole('heading', { name: 'This link is not from Runova' }),
    ).toBeInTheDocument();
  });
});

describe('describeActivity', () => {
  it('says what happened in plain words', () => {
    const entry = { id: 1, teamId: null, ip: null, device: null, at: '2026-11-05T10:00:00.000Z' };

    expect(
      describeActivity({ ...entry, action: 'device-sign-in', details: { device: 'Sam’s PC' } }),
    ).toBe('Signed in Runova on Sam’s PC');
    expect(describeActivity({ ...entry, action: 'sign-in', details: { method: 'google' } })).toBe(
      'Signed in with Google',
    );
    expect(describeActivity({ ...entry, action: 'sign-in', details: { method: 'apple' } })).toBe(
      'Signed in with Apple',
    );
    expect(
      describeActivity({ ...entry, action: 'login-linked', details: { provider: 'microsoft' } }),
    ).toBe('Linked Microsoft');
    expect(
      describeActivity({ ...entry, action: 'login-unlinked', details: { provider: 'apple' } }),
    ).toBe('Unlinked Apple');
    expect(describeActivity({ ...entry, action: 'something-new', details: null })).toBe(
      'something-new',
    );
  });
});

describe('ActivityList', () => {
  const entry = { teamId: null, ip: null, device: 'Firefox on Windows', details: null };

  it('says what is missing, and why, when a filter finds nothing', () => {
    render(
      <ActivityList
        items={[]}
        empty={{ title: 'No failed sign-ins', body: 'Nobody has tried a wrong password.' }}
      />,
    );

    expect(screen.getByText('No failed sign-ins')).toBeInTheDocument();
    expect(screen.getByText('Nobody has tried a wrong password.')).toBeInTheDocument();
  });

  it('puts the entries of each day under that day, and flags the ones worth a look', () => {
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    render(
      <ActivityList
        byDay
        items={[
          { ...entry, id: 1, action: 'sign-in', at: now.toISOString() },
          { ...entry, id: 2, action: 'sign-in-failed', at: yesterday.toISOString() },
        ]}
      />,
    );

    const today = screen.getByRole('region', { name: 'Today' });
    expect(within(today).getByText('Signed in')).toBeInTheDocument();
    const before = screen.getByRole('region', { name: 'Yesterday' });
    expect(within(before).getByText(/Wrong password/)).toHaveTextContent(
      'Wrong password (worth a look)',
    );
  });
});

describe('groupByDay', () => {
  it('keeps the order and starts a new group when the day changes', () => {
    const now = new Date(2026, 10, 6, 15);
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();

    const groups = groupByDay(
      [
        { at: at(6, 9) },
        { at: at(6, 1) },
        { at: at(5, 22) },
        { at: at(1, 8) },
        { at: new Date(2026, 9, 20, 8).toISOString() },
      ],
      now,
    );

    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Sunday', 1],
      ['Oct 20, 2026', 1],
    ]);
  });
});
