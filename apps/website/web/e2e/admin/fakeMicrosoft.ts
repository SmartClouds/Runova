// A Microsoft sign-in for the external sign-in spec: discovery, keys, a consent page that asks who
// is signing in, and a token endpoint that hands back a signed ID token. It listens on 127.0.0.1,
// another site than the localhost the browser uses for Runova, so the browser treats the way back
// as a navigation another site started, as it does with the real login.microsoftonline.com.
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The tenant every personal Microsoft account belongs to. */
export const CONSUMERS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** The client the stack's API signs in as. */
export const FAKE_MICROSOFT = {
  clientId: 'e2e-microsoft-client',
  clientSecret: 'e2e-microsoft-secret',
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyId = createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64url')
  .slice(0, 16);

interface Grant {
  clientId: string;
  nonce: string;
  subject: string;
  email: string;
  name: string;
}

const grants = new Map<string, Grant>();

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function idToken(origin: string, grant: Grant) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid: keyId });
  const payload = base64url({
    iss: `${origin}/${CONSUMERS_TENANT}/v2.0`,
    aud: grant.clientId,
    sub: grant.subject,
    tid: CONSUMERS_TENANT,
    email: grant.email,
    name: grant.name,
    nonce: grant.nonce,
    iat: now,
    nbf: now,
    exp: now + 600,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString(
    'base64url',
  );
  return `${header}.${payload}.${signature}`;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function readBody(request: IncomingMessage) {
  return new Promise<URLSearchParams>((done) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => done(new URLSearchParams(body)));
  });
}

/** Serves the fake; `origin` is the address it listens on, as the API's Authority names it. */
export function fakeMicrosoft(origin: string) {
  const root = `${origin}/common/v2.0`;
  return async (request: IncomingMessage, reply: ServerResponse) => {
    const url = new URL(request.url ?? '/', origin);
    const json = (body: unknown) => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(body));
    };
    switch (url.pathname) {
      case '/common/v2.0/.well-known/openid-configuration':
        return json({
          issuer: `${origin}/{tenantid}/v2.0`,
          authorization_endpoint: `${root}/authorize`,
          token_endpoint: `${root}/token`,
          jwks_uri: `${root}/keys`,
          response_types_supported: ['code'],
          subject_types_supported: ['pairwise'],
          id_token_signing_alg_values_supported: ['RS256'],
        });
      case '/common/v2.0/keys':
        return json({
          keys: [{ ...publicKey.export({ format: 'jwk' }), kid: keyId, use: 'sig', alg: 'RS256' }],
        });
      case '/common/v2.0/authorize': {
        const hidden = ['client_id', 'redirect_uri', 'state', 'nonce']
          .map(
            (name) =>
              `<input type="hidden" name="${name}" value="${escapeHtml(url.searchParams.get(name) ?? '')}">`,
          )
          .join('');
        reply.writeHead(200, { 'content-type': 'text/html' });
        reply.end(`<!doctype html><title>Fake Microsoft</title><h1>Sign in to Microsoft</h1>
<form method="get" action="${root}/approve">${hidden}
<label>Email <input name="email"></label>
<label>Name <input name="name" value="Sam Microsoft"></label>
<label>Account id <input name="subject" value="${randomUUID()}"></label>
<button>Continue</button></form>`);
        return;
      }
      case '/common/v2.0/approve': {
        const code = randomUUID();
        const query = url.searchParams;
        grants.set(code, {
          clientId: query.get('client_id') ?? '',
          nonce: query.get('nonce') ?? '',
          subject: query.get('subject') ?? randomUUID(),
          email: query.get('email') ?? '',
          name: query.get('name') ?? '',
        });
        const back = new URL(query.get('redirect_uri') ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', query.get('state') ?? '');
        reply.writeHead(302, { location: back.toString() });
        reply.end();
        return;
      }
      case '/common/v2.0/token': {
        const form = await readBody(request);
        const grant = grants.get(form.get('code') ?? '');
        grants.delete(form.get('code') ?? '');
        if (!grant || form.get('client_secret') !== FAKE_MICROSOFT.clientSecret) {
          reply.writeHead(400, { 'content-type': 'application/json' });
          reply.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        return json({
          access_token: 'e2e-access',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: idToken(origin, grant),
        });
      }
      default:
        reply.writeHead(404, { 'content-type': 'text/plain' });
        reply.end('Not found');
    }
  };
}
