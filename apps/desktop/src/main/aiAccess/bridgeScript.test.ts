import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_ACCESS_MCP_SERVER, aiAccessBridgeScriptSource } from './bridgeScript';

/**
 * The AI access MCP server as a CLI starts it: node speaking MCP over stdio. It forwards every
 * call to Runova with what it knows about its session, and when Runova wants the user asked in the
 * CLI it asks through MCP elicitation and sends the answer back.
 */

const TOKEN = 'hook-token';
let dir: string;
let script: string;
let server: Server;
let requests: Record<string, unknown>[];
let answers: Record<string, (body: Record<string, unknown>) => unknown>;
let child: ChildProcessWithoutNullStreams | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ai-access-mcp-'));
  requests = [];
  answers = {
    '/app-mcp/tools': () => ({
      ok: true,
      tools: [{ name: 'projects_list', inputSchema: { type: 'object' } }],
    }),
    '/app-mcp/call': () => ({ ok: true, text: 'done' }),
    '/app-mcp/decide': () => ({ ok: true, text: 'carried out' }),
  };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push({ path: req.url, ...parsed });
      const answer = answers[req.url ?? '']?.(parsed) ?? { ok: false, error: 'no route' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const portFile = join(dir, 'hook-server.json');
  writeFileSync(portFile, JSON.stringify({ port, token: TOKEN }));
  script = join(dir, 'runova-app-mcp.cjs');
  writeFileSync(script, aiAccessBridgeScriptSource({ portFile }));
  child = null;
});

afterEach(async () => {
  const running = child;
  if (running && running.exitCode === null && running.signalCode === null) {
    // Windows keeps the child's working folder locked until it has really gone.
    await new Promise<void>((resolve) => {
      running.once('exit', () => resolve());
      running.kill();
    });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A fake MCP client: sends lines, reads lines, and can answer the bridge's own requests. */
function startClient(env: Record<string, string> = {}) {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (!env.RUNOVA_SESSION_ID) delete childEnv.RUNOVA_SESSION_ID;
  if (!env.RUNOVA_AI_ACCESS_KEY) delete childEnv.RUNOVA_AI_ACCESS_KEY;
  const proc = spawn(process.execPath, [script], { env: childEnv, cwd: dir });
  child = proc;
  const queue: Record<string, unknown>[] = [];
  const waiters: ((line: Record<string, unknown>) => void)[] = [];
  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  return {
    send(message: unknown) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    },
    next(): Promise<Record<string, unknown>> {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const initialize = (id: number, elicitation: boolean) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: elicitation ? { elicitation: {} } : {},
    clientInfo: { name: 'claude-code', version: '2.1.0' },
  },
});

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('AI access MCP bridge', () => {
  it('handshakes as runova_app and lists the tools Runova offers', async () => {
    const client = startClient();
    client.send(initialize(1, false));
    expect(await client.next()).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: AI_ACCESS_MCP_SERVER },
      },
    });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(await client.next()).toMatchObject({
      id: 2,
      result: { tools: [{ name: 'projects_list' }] },
    });
    expect(requests[0]).toMatchObject({ path: '/app-mcp/tools', token: TOKEN });
  });

  it('sends a call with the token, its session, its key, its folder and what the client can do', async () => {
    const client = startClient({
      RUNOVA_SESSION_ID: 'tab-1',
      RUNOVA_AI_ACCESS_KEY: 'k'.repeat(64),
    });
    client.send(initialize(1, true));
    await client.next();
    client.send(call(2, 'projects_list', { includeArchived: true }));

    expect(await client.next()).toMatchObject({
      id: 2,
      result: { content: [{ type: 'text', text: 'done' }], isError: false },
    });
    expect(requests[0]).toEqual({
      path: '/app-mcp/call',
      token: TOKEN,
      connectionId: expect.stringMatching(/^[0-9a-f]{32}$/),
      sessionId: 'tab-1',
      sessionKey: 'k'.repeat(64),
      cwd: expect.any(String),
      clientName: 'claude-code',
      canElicit: true,
      tool: 'projects_list',
      args: { includeArchived: true },
    });
  });

  it('sends data back as JSON text and a refusal as an error result', async () => {
    answers['/app-mcp/call'] = (body) =>
      body.tool === 'projects_list'
        ? { ok: true, data: [{ id: 'p1' }] }
        : { ok: false, error: 'AI access is turned off.' };
    const client = startClient();
    client.send(call(1, 'projects_list'));
    const data = (await client.next()).result as { content: { text: string }[] };
    expect(JSON.parse(data.content[0].text)).toEqual([{ id: 'p1' }]);

    client.send(call(2, 'env_save_file'));
    expect(await client.next()).toMatchObject({
      result: { content: [{ text: 'AI access is turned off.' }], isError: true },
    });
  });

  it('asks the user through elicitation and sends their answer to Runova', async () => {
    answers['/app-mcp/call'] = () => ({
      ok: true,
      confirm: { approvalId: 'ap-1', message: 'Claude Code wants to: Save .env' },
    });
    const client = startClient();
    client.send(initialize(1, true));
    await client.next();
    client.send(call(2, 'env_save_file'));

    const ask = await client.next();
    expect(ask).toMatchObject({
      jsonrpc: '2.0',
      method: 'elicitation/create',
      params: {
        message: 'Claude Code wants to: Save .env',
        requestedSchema: { type: 'object', properties: { remember: { type: 'boolean' } } },
      },
    });
    client.send({
      jsonrpc: '2.0',
      id: ask.id,
      result: { action: 'accept', content: { remember: true } },
    });

    expect(await client.next()).toMatchObject({
      id: 2,
      result: { content: [{ text: 'carried out' }], isError: false },
    });
    expect(requests.at(-1)).toEqual({
      path: '/app-mcp/decide',
      token: TOKEN,
      connectionId: requests[0].connectionId,
      approvalId: 'ap-1',
      decision: 'allow_session',
    });
  });

  it('sends a no when the user declines or the client cannot ask', async () => {
    answers['/app-mcp/call'] = () => ({
      ok: true,
      confirm: { approvalId: 'ap-2', message: 'Save?' },
    });
    answers['/app-mcp/decide'] = () => ({ ok: false, error: 'The user declined this request.' });
    const client = startClient();
    client.send(initialize(1, true));
    await client.next();
    client.send(call(2, 'env_save_file'));
    const ask = await client.next();
    client.send({ jsonrpc: '2.0', id: ask.id, result: { action: 'decline' } });

    expect(await client.next()).toMatchObject({
      id: 2,
      result: { content: [{ text: 'The user declined this request.' }], isError: true },
    });
    expect(requests.at(-1)).toMatchObject({ approvalId: 'ap-2', decision: 'deny' });

    client.send(call(3, 'env_save_file'));
    const second = await client.next();
    client.send({ jsonrpc: '2.0', id: second.id, error: { code: -32601, message: 'no' } });
    await client.next();
    expect(requests.at(-1)).toMatchObject({ decision: 'deny' });
  });

  it('says Runova is not running when it cannot reach it', async () => {
    writeFileSync(join(dir, 'hook-server.json'), JSON.stringify({ port: 1, token: TOKEN }));
    const client = startClient();
    client.send(call(1, 'projects_list'));
    expect(await client.next()).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining('Runova is not running') }],
        isError: true,
      },
    });
  });
});
