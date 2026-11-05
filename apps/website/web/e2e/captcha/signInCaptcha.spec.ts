// The sign-in captcha (E52) against the real API: an Admin turns it on from the settings page,
// which first needs a check passed with the new keys, then sign-up and sign-in ask for it, and it
// goes away once turned off. Cloudflare is never reached: the stack's fake siteverify answers for
// the API, and the browser gets a stand-in for Turnstile's script. It runs in a project of its
// own, after every admin spec, since the captcha is on for the whole stack while it runs.
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { createEditor, expect, newApiContext, SIGNED_OUT, signIn, test } from '../admin/fixtures';
import { OWNER } from '../admin/stackConfig';
import { nextCode } from '../admin/totp';

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** Turnstile's API, drawn as a button that plays the person passing the check. */
const FAKE_TURNSTILE = `(() => {
  let count = 0;
  const widgets = {};
  window.turnstile = {
    render(element, options) {
      const id = 'widget-' + (++count);
      const draw = () => {
        element.innerHTML = '';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Pass the test check';
        button.dataset.action = options.action;
        button.onclick = () => {
          button.textContent = 'Check passed';
          button.disabled = true;
          options.callback('e2e-' + options.action + '-' + Date.now());
        };
        element.append(button);
      };
      widgets[id] = draw;
      draw();
      return id;
    },
    reset(id) { widgets[id] && widgets[id](); },
    remove(id) { delete widgets[id]; },
  };
})();`;

async function newPage(browser: Browser, storageState = SIGNED_OUT): Promise<Page> {
  const context = await browser.newContext({ storageState, ignoreHTTPSErrors: true });
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE }),
  );
  return context.newPage();
}

const passCheck = (page: Page) => page.getByRole('button', { name: 'Pass the test check' }).click();

/** Turns the captcha off through the API, whatever the test left behind. */
async function captchaOff(owner: APIRequestContext) {
  const current = await owner.get('/api/v1/sign-in-settings');
  const { cookies } = await owner.storageState();
  const xsrf = decodeURIComponent(cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  const response = await owner.patch('/api/v1/sign-in-settings', {
    data: { captchaEnabled: false },
    headers: {
      'If-Match': current.headers().etag ?? '*',
      'Content-Type': 'application/merge-patch+json',
      'X-XSRF-TOKEN': xsrf,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test('an Admin turns the captcha on after a check, and sign-up and sign-in ask for it', async ({
  browser,
  owner,
}, info) => {
  // Made before the captcha is on: the fixtures sign in through the API without a token.
  const account = await createEditor(owner, info.workerIndex);
  const api = await newApiContext();
  await signIn(api, OWNER.email, OWNER.password);
  const adminState = await api.storageState();
  await api.dispose();

  const admin = await newPage(browser, adminState);
  await admin.goto('/admin/settings');
  await admin.getByRole('checkbox', { name: /Ask for a captcha/ }).check();
  await admin.getByLabel('Site key').fill('0x4AAAAAAAe2esitekey');
  await admin.getByLabel('Secret key').fill('0x4AAAAAAAe2esecret');
  await expect(admin.getByRole('button', { name: 'Save' })).toBeDisabled();
  await admin.getByRole('button', { name: 'Check these keys' }).click();
  await passCheck(admin);
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByText('Saved.', { exact: true })).toBeVisible();
  await info.attach('settings', {
    body: await admin.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  try {
    const register = await newPage(browser);
    await register.goto('/account/register');
    await register.getByLabel('Your name').fill('Captcha Sam');
    await register.getByLabel('Email').fill(`captcha-${Date.now()}@e2e.runovahq.test`);
    await register.getByLabel('Password', { exact: true }).fill('a long enough password');
    await expect(register.getByRole('button', { name: 'Make account' })).toBeDisabled();
    await passCheck(register);
    await register.getByRole('button', { name: 'Make account' }).click();
    await expect(register.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const page = await newPage(browser);
    await page.goto('/account/sign-in');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel(/^Password/).fill(account.password);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await passCheck(page);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // The first token went with the password, so the code step needs a fresh check.
    await page.getByLabel('Code').fill(await nextCode(account));
    await passCheck(page);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);

    const staff = await newPage(browser);
    await staff.goto('/admin/sign-in');
    await expect(staff.getByRole('button', { name: 'Pass the test check' })).toBeVisible();
  } finally {
    await captchaOff(owner);
  }

  const after = await newPage(browser);
  await after.goto('/account/sign-in');
  await expect(after.getByLabel('Email')).toBeVisible();
  await expect(after.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await expect(after.getByRole('button', { name: 'Pass the test check' })).toHaveCount(0);
});
