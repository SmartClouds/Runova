// No secret, cookie or signature leaves the stack in a log line, a Sentry event or an OpenTelemetry
// span. The spec signs in, invites a user who sets a password, changes it, turns two-factor on,
// gets new recovery codes and turns two-factor off, makes an API client, rotates its secret, sends
// signed requests (and one with a wrong signature), opens an admin page with the session, then
// looks for every one of those values in `docker compose logs` and in what the API sent to the
// telemetry sink (compose.test.yaml). It runs alongside the other stack specs, so the output holds
// their requests too.
import { type APIRequestContext, expect, test } from '@playwright/test';
import { signingKey, signRequest } from '../../../../../docs/website/examples/sign-request.ts';
import { nextCode } from '../admin/totp.ts';
import { compose, exec } from './compose.ts';
import { call, newContext, ownerSession, unique } from './stackApi.ts';
import { OWNER } from './stackConfig.ts';
import { type Capture, SINK_FILE } from './telemetrySink.ts';

/** Where each capture came from, by the path the sink saw. */
function channelOf(path: string) {
  if (/^\/api\/\d+\/envelope\/?$/.test(path)) return 'sentry';
  if (path === '/v1/traces') return 'spans';
  if (path === '/v1/logs') return 'logs';
  if (path === '/v1/metrics') return 'metrics';
  return 'other';
}

type Channel = ReturnType<typeof channelOf>;

/** Runs a command in the sink's container and fails with a hint when the sink is not there. */
function inSink(command: string[]) {
  const result = exec('telemetry-sink', command);
  if (result.status !== 0) {
    throw new Error(
      `Could not reach the telemetry sink (${result.stderr.trim()}). Start the stack with compose.test.yaml too.`,
    );
  }
  return result;
}

/**
 * Empties the sink's file. The spec only looks for values it makes itself, so what came before
 * does not matter, and a stack that has run for a while has far more than one read can hold.
 */
function clearTelemetry() {
  inSink(['truncate', '-s', '0', SINK_FILE]);
}

/** Everything the sink has received since `clearTelemetry`, as text per channel. */
function telemetry(): Record<Channel, string> {
  const read = inSink(['cat', SINK_FILE]);
  const text: Record<Channel, string> = { sentry: '', spans: '', logs: '', metrics: '', other: '' };
  for (const line of read.stdout.split('\n')) {
    if (!line) continue;
    const capture = JSON.parse(line) as Capture;
    // latin1 maps every byte to one character, so ASCII values read the same in JSON and protobuf.
    text[channelOf(capture.path)] += `${Buffer.from(capture.body, 'base64').toString('latin1')}\n`;
  }
  return text;
}

/** A signed POST that returns the signature it sent, so the spec can look for it. */
async function signedPost(
  context: APIRequestContext,
  key: { keyId: string; secret: string },
  path: string,
  body: string,
) {
  const url = `/api/v1${path}`;
  const headers = signRequest({ ...key, method: 'POST', url, body });
  const response = await context.post(url, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    data: body,
  });
  return { response, signature: headers['X-Runova-Signature'] };
}

/** The values to look for: each whole, and its last 24 characters to catch one cut short. */
function needles(secrets: Record<string, string>) {
  return Object.entries(secrets).flatMap(([name, value]) => {
    expect(value.length, `${name} is long enough to search for`).toBeGreaterThanOrEqual(16);
    return [
      { name, value },
      { name: `${name} (end)`, value: value.slice(-24) },
    ];
  });
}

/**
 * Recovery codes are short (`XXXXX-XXXXX`), so each is looked for whole. Ten random characters
 * still never turn up in the output by chance.
 */
function recoveryCodeNeedles(codes: string[]) {
  return codes.map((value, index) => {
    expect(value, 'a recovery code').toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    return { name: `recovery code ${index + 1}`, value };
  });
}

/**
 * The invited user's own account: a password change, two-factor on, new recovery codes, and
 * two-factor off again. Adds the new password and the authenticator key to `secrets` and returns
 * every recovery code the API handed out.
 */
async function ownAccountChanges(
  email: string,
  secrets: Record<string, string>,
  id: string,
): Promise<string[]> {
  const session = await newContext();
  try {
    await call(session, '/sessions', {
      email,
      password: secrets['invited user password'],
      twoFactorCode: null,
      recoveryCode: null,
    });
    secrets['changed password'] = `changed-password-${id}-only-here`;
    await call(
      session,
      '/users/me/password',
      {
        currentPassword: secrets['invited user password'],
        newPassword: secrets['changed password'],
      },
      'PUT',
    );

    const setup = await (await call(session, '/users/me/two-factor', undefined)).json();
    secrets['authenticator key'] = setup.sharedKey;
    const authenticator = { secret: setup.sharedKey, lastStep: 0 };
    const first = await (
      await call(session, '/users/me/two-factor', { code: await nextCode(authenticator) }, 'PUT')
    ).json();
    const renewed = await (
      await call(session, '/users/me/two-factor/recovery-codes', {
        code: await nextCode(authenticator),
      })
    ).json();
    expect(renewed.recoveryCodes).toHaveLength(10);
    await call(
      session,
      '/users/me/two-factor',
      { password: secrets['changed password'] },
      'DELETE',
    );
    return [...first.recoveryCodes, ...renewed.recoveryCodes];
  } finally {
    await session.dispose();
  }
}

test('no secret, cookie or signature appears in logs, Sentry events or spans', async ({ page }) => {
  test.setTimeout(120_000);
  clearTelemetry();
  const id = unique();
  const secrets: Record<string, string> = { 'owner password': OWNER.password };
  let recoveryCodes: string[] = [];

  // A staff session: the password goes in, cookies and the antiforgery token come back.
  const owner = await ownerSession();
  try {
    secrets['antiforgery request token'] = (
      await (await owner.get('/api/v1/csrf-tokens/current')).json()
    ).token;
    for (const cookie of (await owner.storageState()).cookies) {
      secrets[`cookie ${cookie.name}`] = cookie.value;
    }
    expect(Object.keys(secrets)).toContain('cookie __Host-runova-session');

    // An invitation: its setup token, then the password the invited user sets with it.
    const invitedEmail = `secrets-${id}@stack.runovahq.test`;
    const invited = await (
      await call(owner, '/users', {
        email: invitedEmail,
        displayName: `Secrets ${id}`,
        roles: ['Editor'],
      })
    ).json();
    const token = new URL(invited.setupLink.url).hash.replace(/^#token=/, '');
    secrets['setup token'] = token;
    secrets['invited user password'] = `invited-password-${id}-only-here`;
    const visitor = await newContext();
    try {
      await call(visitor, '/password-setups', {
        token,
        password: secrets['invited user password'],
      });
    } finally {
      await visitor.dispose();
    }
    recoveryCodes = await ownAccountChanges(invitedEmail, secrets, id);

    // An API client: the secret it is created with, its signing key, and the rotated secret.
    const created = await (
      await call(owner, '/api-clients', {
        name: `Secrets client ${id}`,
        scopes: ['news:write'],
        ipAllowlist: [],
        expiresAt: null,
      })
    ).json();
    secrets['client secret'] = created.secret;
    secrets['client signing key'] = signingKey(created.secret).toString('hex');
    const rotated = await (
      await call(owner, `/api-clients/${created.client.id}/secrets`, { overlapMinutes: 0 })
    ).json();
    secrets['rotated client secret'] = rotated.secret;
    secrets['rotated signing key'] = signingKey(rotated.secret).toString('hex');

    // Signed requests: one that posts a news item, one with the old key, now refused.
    const client = await newContext();
    try {
      const body = JSON.stringify({
        slug: `secrets-${id}`,
        title: `Secrets check ${id}`,
        summary: 'A news item posted while the secrets spec watches the telemetry.',
        bodyMarkdown: 'Posted by the secrets spec.',
        category: 'industry',
        severity: 'info',
        technologies: [],
        cveIds: [],
        cvssScore: null,
        sourceLinks: [],
        tags: [],
        status: 'draft',
        publishedAt: null,
      });
      const posted = await signedPost(
        client,
        { keyId: rotated.keyId, secret: rotated.secret },
        '/news',
        body,
      );
      expect(posted.response.status(), await posted.response.text()).toBe(201);
      secrets.signature = posted.signature.replace(/^v1=/, '');
      const refused = await signedPost(
        client,
        { keyId: created.keyId, secret: created.secret },
        '/news',
        body,
      );
      expect(refused.response.status()).toBe(401);
      secrets['refused signature'] = refused.signature.replace(/^v1=/, '');
    } finally {
      await client.dispose();
    }

    // The site's server passes the session cookie on to the API.
    await page.context().addCookies((await owner.storageState()).cookies);
  } finally {
    await owner.dispose();
  }
  await page.goto('/admin/news');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // A marker request last: once it shows in every channel, everything before it has been sent.
  const marker = `/api/v1/news/secrets-marker-${id}`;
  const visitor = await newContext();
  try {
    expect((await visitor.get(marker)).status()).toBe(404);
  } finally {
    await visitor.dispose();
  }
  let sent = telemetry();
  await expect
    .poll(
      () => {
        sent = telemetry();
        return (['sentry', 'spans', 'logs'] as const).filter((c) => !sent[c].includes(marker));
      },
      { message: 'the marker request reached Sentry, spans and logs', timeout: 60_000 },
    )
    .toEqual([]);
  expect(sent.metrics.length, 'metrics reached the sink').toBeGreaterThan(0);

  const logs = compose(['logs', '--no-color', '--no-log-prefix']);
  expect(logs.status, logs.stderr).toBe(0);
  expect(logs.stdout).toContain(marker);

  const outputs = { 'container logs': logs.stdout + logs.stderr, ...sent };
  const leaks = [...needles(secrets), ...recoveryCodeNeedles(recoveryCodes)].flatMap(
    ({ name, value }) =>
      Object.entries(outputs)
        .filter(([, text]) => text.includes(value))
        .map(([where]) => `${name} in ${where}`),
  );
  expect(leaks).toEqual([]);
});
