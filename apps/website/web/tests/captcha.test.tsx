// @vitest-environment jsdom
import './setup/dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetTurnstileScript,
  TURNSTILE_SCRIPT,
  useCaptcha,
} from '../src/components/account/Captcha';
import type { CaptchaConfig } from '../src/lib/account/signInOptions';
import { captchaOn, fakeTurnstile } from './helpers/fakeTurnstile';

let latest: ReturnType<typeof useCaptcha>;

function Harness({
  config,
  action = 'sign-in',
}: {
  config: CaptchaConfig | null;
  action?: string;
}) {
  latest = useCaptcha(config, action);
  return (
    <div>
      {latest.widget}
      <output data-testid="token">{latest.token ?? 'none'}</output>
    </div>
  );
}

afterEach(() => {
  forgetTurnstileScript();
  for (const script of document.querySelectorAll('script')) script.remove();
});

describe('useCaptcha', () => {
  it('renders nothing and needs nothing while the captcha is off', () => {
    const turnstile = fakeTurnstile();
    const { container } = render(<Harness config={null} />);

    expect(latest.required).toBe(false);
    expect(container.querySelector('[data-captcha]')).toBeNull();
    expect(turnstile.api.render).not.toHaveBeenCalled();
  });

  it('renders the widget with the site key and the form it is for', async () => {
    const turnstile = fakeTurnstile();
    render(<Harness config={captchaOn} action="register" />);

    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalledTimes(1));
    const { options, element } = turnstile.widget();
    expect(options).toMatchObject({
      sitekey: captchaOn.siteKey,
      action: 'register',
      theme: 'auto',
    });
    expect(element.closest('[data-captcha]')).not.toBeNull();
    expect(latest.required).toBe(true);
  });

  it('holds the token the widget hands over until it runs out', async () => {
    const turnstile = fakeTurnstile();
    render(<Harness config={captchaOn} />);
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());

    turnstile.solve('tok-1');
    expect(screen.getByTestId('token')).toHaveTextContent('tok-1');

    turnstile.expire();
    expect(screen.getByTestId('token')).toHaveTextContent('none');
  });

  it('says so when the check can not load, and holds no token', async () => {
    const turnstile = fakeTurnstile();
    render(<Harness config={captchaOn} />);
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-1');

    turnstile.fail();

    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(screen.getByText(/check could not load/)).toBeInTheDocument();
  });

  it('starts a fresh check on reset, since a token works once', async () => {
    const turnstile = fakeTurnstile();
    render(<Harness config={captchaOn} />);
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    turnstile.solve('tok-1');

    act(() => latest.reset());

    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(turnstile.api.reset).toHaveBeenCalledWith('widget-1');
  });

  it('shows what the API said about the check under the widget', async () => {
    fakeTurnstile();
    render(<Harness config={captchaOn} />);

    act(() => latest.showErrors(['Complete the check that you are a person, then try again.']));

    expect(screen.getByText(/Complete the check/)).toBeInTheDocument();
  });

  it('removes the widget when the form goes away', async () => {
    const turnstile = fakeTurnstile();
    const { unmount } = render(<Harness config={captchaOn} />);
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());

    unmount();

    expect(turnstile.api.remove).toHaveBeenCalledWith('widget-1');
  });

  it("loads Cloudflare's script once, however many forms need it", async () => {
    render(
      <>
        <Harness config={captchaOn} />
        <Harness config={captchaOn} action="verification-email" />
      </>,
    );

    const scripts = document.querySelectorAll(`script[src="${TURNSTILE_SCRIPT}"]`);
    expect(scripts).toHaveLength(1);

    const turnstile = fakeTurnstile();
    act(() => scripts[0]?.dispatchEvent(new Event('load')));

    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalledTimes(2));
  });

  it('asks for the explicit render mode, so it never renders on its own', () => {
    expect(TURNSTILE_SCRIPT).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    );
    vi.unstubAllGlobals();
  });
});
