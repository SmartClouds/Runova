import type { PostmanRequestItem } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiExecutionResult, ExecuteApiRequestInput } from '../../../shared/apiClientTypes';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

const sent = vi.hoisted(() => ({ inputs: [] as ExecuteApiRequestInput[] }));

vi.mock('../../ipc/apiClient', () => ({
  executeApiRequest: async (input: ExecuteApiRequestInput): Promise<ApiExecutionResult> => {
    sent.inputs.push(input);
    return {
      requestId: input.requestId,
      ok: true,
      cancelled: false,
      error: null,
      response: {
        status: 200,
        statusText: 'OK',
        headers: [{ key: 'content-type', value: 'application/json' }],
        body: '{"token":"abc"}',
        bodyEncoding: 'utf8',
        bodyTruncated: false,
        mime: 'application/json',
        size: { body: 15, headers: 30 },
        timings: { dns: 0, tcp: 0, tls: 0, firstByte: 40, download: 2, total: 42 },
        httpVersion: '1.1',
      },
      sent: null,
      tests: [{ name: 'is 200', passed: true, skipped: false, error: null }],
      console: [],
      scriptErrors: [],
      startedAt: 0,
    };
  },
}));

/**
 * The API Client tools: an agent adds a sample request ("add a login request for testing"), finds
 * collections and requests by name, and sends a request through the same runner the app uses.
 */

useTempUserData();

const context: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
let tools: Map<string, AiTool>;
let store: typeof import('../../apiClient/collectionStore')['collectionStore'];

beforeEach(async () => {
  sent.inputs = [];
  store = (await import('../../apiClient/collectionStore')).collectionStore;
  const { apiClientTools } = await import('./apiClient');
  tools = new Map(apiClientTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown>) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown>) {
  const tool = tools.get(name) as AiTool;
  return tool.preview(tool.input.parse(args), context);
}

function requestsOf(items: unknown[]): PostmanRequestItem[] {
  return items.flatMap((item) => {
    const one = item as { item?: unknown[] };
    return one.item ? requestsOf(one.item) : [item as PostmanRequestItem];
  });
}

describe('api_save_request', () => {
  it('adds a JSON request to a collection made on the spot, inside a new folder', async () => {
    const result = await run('api_save_request', {
      collection: 'Shop API',
      createCollection: true,
      folder: 'Auth',
      name: 'Login',
      method: 'post',
      url: '{{baseUrl}}/login',
      headers: [{ key: 'Accept', value: 'application/json' }],
      body: '{"email":"test@example.com","password":"secret"}',
      bodyType: 'json',
    });

    expect(result.text).toContain('Added Login to Shop API');
    const [summary] = await store.list();
    const collection = await store.get(summary.id);
    const folder = collection.item[0] as { name: string; item: PostmanRequestItem[] };
    expect(folder.name).toBe('Auth');
    expect(folder.item[0].request).toMatchObject({
      method: 'POST',
      url: { raw: '{{baseUrl}}/login' },
      header: [{ key: 'Accept', value: 'application/json' }],
      body: {
        mode: 'raw',
        raw: expect.stringContaining('test@example.com'),
        options: { raw: { language: 'json' } },
      },
    });
  });

  it('updates the request with the same name instead of adding a second one', async () => {
    await run('api_save_request', {
      collection: 'Shop',
      createCollection: true,
      name: 'Ping',
      method: 'GET',
      url: 'https://a.test',
    });
    const second = await run('api_save_request', {
      collection: 'shop',
      name: 'ping',
      method: 'GET',
      url: 'https://b.test',
    });

    expect(second.text).toContain('Updated Ping in Shop');
    const collection = await store.get((await store.list())[0].id);
    expect(requestsOf(collection.item).map((one) => one.request.url)).toEqual([
      { raw: 'https://b.test' },
    ]);
  });

  it('adds bearer auth', async () => {
    await run('api_save_request', {
      collection: 'Shop',
      createCollection: true,
      name: 'Me',
      method: 'GET',
      url: 'https://a.test/me',
      bearerToken: '{{token}}',
    });
    const collection = await store.get((await store.list())[0].id);
    expect(requestsOf(collection.item)[0].request.auth).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
    });
  });

  it('shows the request before saving it', async () => {
    expect(
      await preview('api_save_request', {
        collection: 'Shop',
        createCollection: true,
        name: 'Login',
        method: 'POST',
        url: 'https://a.test/login',
        body: '{"a":1}',
      }),
    ).toMatchObject({
      title: 'Add Login to Shop',
      request: { method: 'POST', url: 'https://a.test/login', body: '{"a":1}' },
    });
  });

  it('names the collections there are when it cannot find the one asked for', async () => {
    await store.create('Billing');
    await expect(
      run('api_save_request', {
        collection: 'Shop',
        name: 'X',
        method: 'GET',
        url: 'https://a.test',
      }),
    ).rejects.toThrow(/No collection named Shop.*Billing/);
  });
});

describe('listing and reading', () => {
  it('lists collections with their requests, and reads one in full', async () => {
    await run('api_save_request', {
      collection: 'Shop',
      createCollection: true,
      folder: 'Auth',
      name: 'Login',
      method: 'POST',
      url: 'https://a.test/login',
    });

    const list = (await run('api_list_collections', {})).data as {
      name: string;
      requests: string[];
    }[];
    expect(list).toEqual([
      expect.objectContaining({ name: 'Shop', requestCount: 1, requests: ['Auth / Login (POST)'] }),
    ]);

    const full = (await run('api_get_collection', { collection: 'Shop' })).data as {
      items: unknown[];
    };
    expect(JSON.stringify(full.items)).toContain('https://a.test/login');
  });
});

describe('api_send_request', () => {
  it('sends a saved request with its collection, and reports the response and tests', async () => {
    await run('api_save_request', {
      collection: 'Shop',
      createCollection: true,
      name: 'Login',
      method: 'POST',
      url: 'https://a.test/login',
    });

    const shown = await preview('api_send_request', { collection: 'Shop', request: 'login' });
    expect(shown).toMatchObject({
      title: 'Send Login',
      request: { method: 'POST', url: 'https://a.test/login' },
    });

    const result = await run('api_send_request', { collection: 'Shop', request: 'Login' });

    expect(sent.inputs[0]).toMatchObject({
      collectionId: (await store.list())[0].id,
      request: { method: 'POST' },
      name: 'Login',
    });
    expect(result.data).toMatchObject({
      status: 200,
      timeMs: 42,
      body: '{"token":"abc"}',
      tests: [{ name: 'is 200', passed: true }],
    });
  });
});

describe('api_remove_item', () => {
  it('removes a request by name', async () => {
    await run('api_save_request', {
      collection: 'Shop',
      createCollection: true,
      name: 'Old',
      method: 'GET',
      url: 'https://a.test',
    });
    expect((await preview('api_remove_item', { collection: 'Shop', item: 'Old' })).title).toBe(
      'Delete Old from Shop',
    );

    await run('api_remove_item', { collection: 'Shop', item: 'Old' });

    expect((await store.list())[0].requestCount).toBe(0);
  });
});
