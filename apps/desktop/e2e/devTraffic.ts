import { request } from 'node:http';
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Steps the traffic specs (E109, E110) share against the DevHost: signing in, putting a site on its
 * pretend nginx, turning statistics on in the Traffic settings, and the DevHost's loopback-only
 * seeding endpoints, which write log lines and have the core read them at once.
 */

export const DEV_PASSWORD = 'runova-local-password';

/** Calls one of the DevHost's `/dev/...` endpoints and hands back its JSON answer. */
export function devPost<T>(port: number, path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { host: 'runova-core', 'content-type': 'application/json' },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          if (response.statusCode === 200) resolve(JSON.parse(text) as T);
          else reject(new Error(`The DevHost answered ${response.statusCode} to ${path}.`));
        });
      },
    );
    call.once('error', reject);
    call.end(JSON.stringify(body));
  });
}

export async function signIn(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await dialog.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
}

export async function openSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name, exact: true })
    .click();
}

/** Waits for the job dialog's outcome, then closes it. */
async function finishJob(page: Page): Promise<void> {
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('log', { name: 'Job log' }) });
  await expect(dialog.getByRole('status')).toHaveText(/Done/, { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
}

/** Sets nginx up when it is not Runova's yet, then saves a site for each domain. */
export async function addSites(page: Page, domains: string[]): Promise<void> {
  await openSection(page, 'Websites');
  const setUp = page.getByRole('button', { name: /Set up nginx for Runova|Install nginx/ });
  await expect(setUp.or(page.getByText('Managed by Runova'))).toBeVisible({ timeout: 30_000 });
  if (await setUp.isVisible()) {
    await setUp.click();
    await finishJob(page);
  }
  await expect(page.getByText('Managed by Runova')).toBeVisible({ timeout: 30_000 });
  for (const [index, domain] of domains.entries()) {
    await page.getByRole('button', { name: /Add a site/ }).click();
    await page.getByRole('textbox', { name: 'Domain 1' }).fill(domain);
    await page.getByRole('tab', { name: 'Proxy' }).click();
    await page.getByLabel('Service name').fill(`app${index}`);
    await page.getByLabel('Port').fill(String(3000 + index));
    await page.getByRole('button', { name: /Save the site/ }).click();
    await expect(page.getByRole('tab', { name: 'SSL', selected: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /All sites/ }).click();
  }
}

/** The Traffic section's own Settings button, beside live visitors. */
export function trafficSettingsButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Traffic settings' });
}

/** Opens the Traffic settings and turns statistics on or off there. */
export async function setStatistics(page: Page, on: boolean): Promise<void> {
  await trafficSettingsButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Traffic settings' });
  const count = dialog.getByRole('switch', { name: 'Count traffic' });
  if ((await count.isChecked()) !== on) await count.click();
  await dialog.getByRole('button', { name: 'Save statistics' }).click();
  await expect(
    page.getByText(on ? 'Traffic statistics saved.' : /Traffic statistics are off\. The figures/),
  ).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
}
