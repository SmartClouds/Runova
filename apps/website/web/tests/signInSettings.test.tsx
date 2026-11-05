// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import SignInSettingsEditor from '../src/components/admin/SignInSettingsEditor';
import type { SignInSettings } from '../src/lib/admin/signInSettings';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';
import { fakeTurnstile } from './helpers/fakeTurnstile';

const SETTINGS = '/api/v1/sign-in-settings';

const BASE: SignInSettings = {
  captchaEnabled: false,
  turnstileSiteKey: null,
  hasTurnstileSecret: false,
  googleEnabled: true,
  googleActive: true,
  googleClientId: '123.apps.googleusercontent.com',
  hasGoogleClientSecret: true,
  googleFromEnvironment: false,
  googleCallbackUrl: 'https://runovahq.com/api/oauth/google/callback',
  googleOnlyAccounts: 0,
  updatedAt: null,
  version: '7',
};

const answer = (settings: Partial<SignInSettings> = {}) => {
  const value = { ...BASE, ...settings };
  return json(value, { headers: { etag: `"${value.version}"` } });
};

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/admin/settings');
});

describe('SignInSettingsEditor', () => {
  it('shows what is on, without ever showing a secret', async () => {
    fakeFetch({ [`GET ${SETTINGS}`]: answer() });
    render(<SignInSettingsEditor />);

    expect(await screen.findByLabelText('Client ID')).toHaveValue('123.apps.googleusercontent.com');
    expect(screen.getByRole('checkbox', { name: /Continue with Google/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /captcha/ })).not.toBeChecked();
    expect(screen.getByText(/A client secret is saved/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Client secret')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Authorized redirect URI')).toHaveValue(
      'https://runovahq.com/api/oauth/google/callback',
    );
    expect(screen.getByText(/shows on the sign-in pages/)).toBeInTheDocument();
  });

  it('saves new Google keys with the version it read', async () => {
    const api = fakeFetch({
      [`GET ${SETTINGS}`]: answer({
        googleClientId: null,
        hasGoogleClientSecret: false,
        googleActive: false,
      }),
      [`PATCH ${SETTINGS}`]: answer({ version: '8' }),
    });
    const user = userEvent.setup();
    render(<SignInSettingsEditor />);

    await user.type(await screen.findByLabelText('Client ID'), 'new.apps.googleusercontent.com');
    await user.type(screen.getByLabelText('Client secret'), 'GOCSPX-secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const [patch] = api.calls(`PATCH ${SETTINGS}`);
    expect(patch?.headers.get('if-match')).toBe('"7"');
    expect(patch?.json()).toEqual({
      captchaEnabled: false,
      turnstileSiteKey: null,
      googleEnabled: true,
      googleClientId: 'new.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('replaces a saved secret only when one is typed', async () => {
    const api = fakeFetch({
      [`GET ${SETTINGS}`]: answer(),
      [`PATCH ${SETTINGS}`]: answer({ version: '8' }),
    });
    const user = userEvent.setup();
    render(<SignInSettingsEditor />);

    await user.click(await screen.findByRole('button', { name: 'Replace the client secret' }));
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved.');
    expect(api.calls(`PATCH ${SETTINGS}`)[0]?.json()).not.toHaveProperty('googleClientSecret');
  });

  it('turns the captcha on only after the new keys pass a check', async () => {
    const turnstile = fakeTurnstile();
    const api = fakeFetch({
      [`GET ${SETTINGS}`]: answer(),
      [`PATCH ${SETTINGS}`]: answer({
        captchaEnabled: true,
        turnstileSiteKey: '0x4AAAsite',
        hasTurnstileSecret: true,
        version: '8',
      }),
    });
    const user = userEvent.setup();
    render(<SignInSettingsEditor />);

    await user.click(await screen.findByRole('checkbox', { name: /captcha/ }));
    await user.type(screen.getByLabelText('Site key'), '0x4AAAsite');
    await user.type(screen.getByLabelText('Secret key'), '0x4AAAsecret');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Check these keys' }));
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    expect(turnstile.widget().options).toMatchObject({
      sitekey: '0x4AAAsite',
      action: 'settings-check',
    });
    turnstile.solve('tok-check', 'settings-check');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(api.calls(`PATCH ${SETTINGS}`)[0]?.json()).toEqual({
      captchaEnabled: true,
      turnstileSiteKey: '0x4AAAsite',
      turnstileSecret: '0x4AAAsecret',
      captchaToken: 'tok-check',
      googleEnabled: true,
      googleClientId: '123.apps.googleusercontent.com',
    });
  });

  it('needs a new check when the site key changes after one passed', async () => {
    const turnstile = fakeTurnstile();
    fakeFetch({ [`GET ${SETTINGS}`]: answer() });
    const user = userEvent.setup();
    render(<SignInSettingsEditor />);
    await user.click(await screen.findByRole('checkbox', { name: /captcha/ }));
    await user.type(screen.getByLabelText('Site key'), '0x4AAAsite');
    await user.type(screen.getByLabelText('Secret key'), '0x4AAAsecret');
    await user.click(screen.getByRole('button', { name: 'Check these keys' }));
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-check', 'settings-check');

    await user.type(screen.getByLabelText('Site key'), '2');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('turns the captcha off with no check', async () => {
    const api = fakeFetch({
      [`GET ${SETTINGS}`]: answer({
        captchaEnabled: true,
        turnstileSiteKey: '0x4AAAsite',
        hasTurnstileSecret: true,
      }),
      [`PATCH ${SETTINGS}`]: answer({
        turnstileSiteKey: '0x4AAAsite',
        hasTurnstileSecret: true,
        version: '8',
      }),
    });
    const user = userEvent.setup();
    render(<SignInSettingsEditor />);

    await user.click(await screen.findByRole('checkbox', { name: /captcha/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved.');
    expect(api.calls(`PATCH ${SETTINGS}`)[0]?.json()).toMatchObject({ captchaEnabled: false });
    expect(api.calls(`PATCH ${SETTINGS}`)[0]?.json()).not.toHaveProperty('captchaToken');
  });

  it('warns before Google goes off for people who only sign in with it', async () => {
    fakeFetch({ [`GET ${SETTINGS}`]: answer({ googleOnlyAccounts: 3 }) });
    const user = userEvent.setup();
    render(<SignInSettingsEditor />);

    await user.click(await screen.findByRole('checkbox', { name: /Continue with Google/ }));

    expect(screen.getByText(/3 accounts can only sign in with Google/)).toBeInTheDocument();
  });

  it('says where keys left empty come from', async () => {
    fakeFetch({
      [`GET ${SETTINGS}`]: answer({
        googleClientId: null,
        hasGoogleClientSecret: false,
        googleFromEnvironment: true,
      }),
    });
    render(<SignInSettingsEditor />);

    expect(await screen.findByText(/come from the server's environment/)).toBeInTheDocument();
  });

  it('shows what the API refused under the field', async () => {
    fakeFetch({
      [`GET ${SETTINGS}`]: answer(),
      [`PATCH ${SETTINGS}`]: problem(400, 'validation-failed', {
        errors: { googleClientId: ['Give at most 300 characters.'] },
      }),
    });
    const user = userEvent.setup();
    render(<SignInSettingsEditor />);

    await user.type(await screen.findByLabelText('Client ID'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Give at most 300 characters.')).toBeInTheDocument();
  });

  it('offers their version when someone else saved first', async () => {
    const api = fakeFetch({
      [`GET ${SETTINGS}`]: [answer(), answer({ googleEnabled: false, version: '9' })],
      [`PATCH ${SETTINGS}`]: problem(412, 'precondition-failed', { currentVersion: '9' }),
    });
    const user = userEvent.setup();
    render(<SignInSettingsEditor />);

    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Load their version' }));

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Continue with Google/ })).not.toBeChecked(),
    );
    expect(api.calls(`GET ${SETTINGS}`)).toHaveLength(2);
  });
});
