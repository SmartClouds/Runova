// The admin e2e stack, started by playwright.config.ts: PostgreSQL in a container, the real API
// with an owner account, a site server that reads that API, and an HTTPS proxy in front of both so
// the browser sees one origin, as it does in production. Runs under node, since Testcontainers
// needs it. Everything stops when Playwright ends the process.
import { type ChildProcess, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { OWNER, STACK } from './stackConfig.ts';

const web = resolve(import.meta.dirname, '../..');
const api = resolve(web, '../api');
const project = join(api, 'src/Runova.Website.Api/Runova.Website.Api.csproj');
const dll = join(api, 'src/Runova.Website.Api/bin/Release/net10.0/Runova.Website.Api.dll');
const scratch = mkdtempSync(join(tmpdir(), 'runova-admin-e2e-'));
const certificate = join(scratch, 'localhost.pfx');
const media = join(scratch, 'media');
const mediaTypes: Record<string, string> = {
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const certificatePassword = 'runova-e2e';
const children: ChildProcess[] = [];
let database: StartedTestContainer | undefined;

function log(message: string) {
  console.log(`[admin stack] ${message}`);
}

/** Runs a command to the end and fails on a non-zero exit, with its output in the error. */
function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string },
) {
  return new Promise<void>((done, fail) => {
    const child = spawn(command, args, { cwd: api, env: options.env ?? process.env });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.stdin.end(options.input ?? '');
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0
        ? done()
        : fail(new Error(`${command} ${args.join(' ')} exited ${code}\n${output}`)),
    );
  });
}

/** Starts a long-running process that lives until the stack stops. */
function start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[admin stack] ${command} stopped (${code ?? signal}); stopping the stack.`);
      void stop(1);
    }
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, what: string, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((wake) => setTimeout(wake, 250));
  }
  throw new Error(`${what} did not answer at ${url} within ${timeoutMs / 1000} s`);
}

/** Serves an uploaded file the way the production reverse proxy does; the API only does in Development. */
function serveMedia(path: string, reply: ServerResponse) {
  const file = resolve(media, decodeURIComponent(path.slice('/media/'.length)));
  if (!file.startsWith(media + sep) || !existsSync(file) || !statSync(file).isFile()) {
    reply.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  reply.writeHead(200, {
    'content-type': mediaTypes[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(reply);
}

function forward(request: IncomingMessage, reply: ServerResponse) {
  const path = (request.url ?? '').split('?')[0];
  if (path.startsWith('/media/')) {
    serveMedia(path, reply);
    return;
  }
  // The API also serves the jobs dashboard, as it does behind the production proxy.
  const toApi = /^\/(?:api|hangfire)(?:\/|$)/.test(path);
  const send = toApi ? httpsRequest : httpRequest;
  const upstream = send(
    {
      host: '127.0.0.1',
      port: toApi ? STACK.apiHttpsPort : STACK.sitePort,
      method: request.method,
      path: request.url,
      headers: request.headers,
      // The API serves the same self-signed certificate the proxy does.
      rejectUnauthorized: false,
    },
    (answer) => {
      reply.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      answer.pipe(reply);
    },
  );
  upstream.on('error', (error) => {
    if (!reply.headersSent) reply.writeHead(502, { 'content-type': 'text/plain' });
    reply.end(`Proxy error: ${error.message}`);
  });
  request.pipe(upstream);
}

let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  await database?.stop().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop(0));

try {
  log('starting PostgreSQL and building the API');
  const [container] = await Promise.all([
    new GenericContainer('postgres:18')
      .withEnvironment({ POSTGRES_PASSWORD: 'e2e', POSTGRES_DB: 'runova' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    run('dotnet', ['build', project, '-c', 'Release', '--nologo', '-v', 'q'], {}),
    run('dotnet', ['dev-certs', 'https', '-ep', certificate, '-p', certificatePassword], {}),
  ]);
  database = container;

  const apiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ASPNETCORE_ENVIRONMENT: 'Production',
    ConnectionStrings__Default: `Host=${container.getHost()};Port=${container.getMappedPort(5432)};Database=runova;Username=postgres;Password=e2e`,
    Website__SiteUrl: `https://localhost:${STACK.proxyPort}`,
    Website__MediaPath: media,
    ASPNETCORE_URLS: `https://127.0.0.1:${STACK.apiHttpsPort};http://127.0.0.1:${STACK.apiHttpPort}`,
    Kestrel__Certificates__Default__Path: certificate,
    Kestrel__Certificates__Default__Password: certificatePassword,
  };
  log('migrating and making the owner');
  await run('dotnet', [dll, 'admin', 'migrate'], { env: apiEnv });
  await run(
    'dotnet',
    [dll, 'admin', 'create-owner', '--email', OWNER.email, '--name', OWNER.displayName],
    { env: apiEnv, input: `${OWNER.password}\n` },
  );
  start('dotnet', [dll], api, apiEnv);
  await waitFor(`http://127.0.0.1:${STACK.apiHttpPort}/health/ready`, 'The API');

  // The chromium project's server builds the site; this one serves the same build once it is done.
  await waitFor(
    `http://127.0.0.1:${Number(process.env.E2E_PORT || 4329)}/`,
    'The site build',
    300_000,
  );
  if (!existsSync(join(web, 'dist/server/entry.mjs'))) throw new Error('No site build in dist.');
  start('bun', ['./dist/server/entry.mjs'], web, {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(STACK.sitePort),
    WEBSITE_API_INTERNAL_URL: `http://127.0.0.1:${STACK.apiHttpPort}`,
  });
  await waitFor(`http://127.0.0.1:${STACK.sitePort}/`, 'The admin site server');

  const proxy = createServer(
    { pfx: readFileSync(certificate), passphrase: certificatePassword },
    forward,
  );
  proxy.listen(STACK.proxyPort, '127.0.0.1');
  log(`ready at https://localhost:${STACK.proxyPort}`);
} catch (error) {
  console.error(error);
  await stop(1);
}
