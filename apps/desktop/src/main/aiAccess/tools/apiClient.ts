import { randomUUID } from 'node:crypto';
import {
  isFolder,
  type PostmanCollection,
  type PostmanItem,
  type PostmanRequest,
  type PostmanRequestItem,
} from '@runova/core';
import { z } from 'zod';
import type { AiApprovalPreview } from '../../../shared/aiAccessTypes';
import type { ApiCollectionSummary } from '../../../shared/apiClientTypes';
import { collectionStore } from '../../apiClient/collectionStore';
import { executeApiRequest } from '../../ipc/apiClient';
import { defineTool } from '../registry';

/**
 * API Client tools: what an agent needs to add a sample request ("add a login request to test
 * with"), find what is there and try a request. Collections, folders and requests are found by
 * name (any case) or id, the way a person names them. Saving goes through the collection store
 * and sending through the same runner as the API Client tab.
 */

const collectionArg = z
  .string()
  .min(1)
  .describe('The collection, by name or id. api_list_collections lists them.');

const MAX_BODY_SHOWN = 20_000;

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function findCollection(ref: string): Promise<ApiCollectionSummary> {
  const all = await collectionStore.list();
  const found = all.find((one) => one.id === ref) ?? all.find((one) => same(one.name, ref));
  if (found) return found;
  const names = all.map((one) => one.name).join(', ');
  throw new Error(
    names
      ? `No collection named ${ref}. There are: ${names}. Pass createCollection: true to make it.`
      : `No collection named ${ref}: there are none yet. Pass createCollection: true to make it.`,
  );
}

interface Located<T> {
  item: T;
  path: string[];
}

function walk(items: PostmanItem[], path: string[] = []): Located<PostmanItem>[] {
  return items.flatMap((item) => [
    { item, path },
    ...(isFolder(item) ? walk(item.item, [...path, item.name]) : []),
  ]);
}

function findItem(collection: PostmanCollection, ref: string): Located<PostmanItem> {
  const all = walk(collection.item);
  const byId = all.find((one) => one.item.id === ref);
  if (byId) return byId;
  const matches = all.filter((one) => same(one.item.name, ref));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} items are named ${ref}: ${matches.map((one) => [...one.path, one.item.name].join(' / ')).join(', ')}. Pass the id from api_get_collection.`,
    );
  }
  throw new Error(`${collection.info.name} has nothing named ${ref}.`);
}

function urlText(request: PostmanRequest): string {
  if (typeof request.url === 'string') return request.url;
  return request.url?.raw ?? '';
}

function headersOf(request: PostmanRequest): { key: string; value: string }[] {
  return Array.isArray(request.header)
    ? request.header
        .filter((header) => !header.disabled)
        .map((header) => ({ key: header.key, value: header.value ?? '' }))
    : [];
}

function previewOf(title: string, request: PostmanRequest): AiApprovalPreview {
  return {
    title,
    request: {
      method: request.method ?? 'GET',
      url: urlText(request),
      headers: headersOf(request),
      body: request.body?.raw,
    },
  };
}

const requestInput = z.object({
  collection: collectionArg,
  createCollection: z
    .boolean()
    .optional()
    .describe('Make the collection when there is none by that name.'),
  folder: z
    .string()
    .optional()
    .describe('A folder at the top of the collection to put a new request in. Made when missing.'),
  name: z
    .string()
    .min(1)
    .max(200)
    .describe('The request name. A request with this name is updated.'),
  method: z.string().min(1).max(16).describe('GET, POST, PUT, PATCH, DELETE and so on.'),
  url: z.string().min(1).describe('The address. Collection variables like {{baseUrl}} work.'),
  headers: z.array(z.object({ key: z.string().min(1), value: z.string() })).optional(),
  body: z.string().optional().describe('The raw body.'),
  bodyType: z
    .enum(['json', 'text', 'xml'])
    .optional()
    .describe('How to show the body. Defaults to json when it parses.'),
  bearerToken: z
    .string()
    .optional()
    .describe('Adds bearer auth with this token or a {{variable}}.'),
});

type RequestInput = z.infer<typeof requestInput>;

function buildRequest(args: RequestInput): PostmanRequest {
  const request: PostmanRequest = {
    method: args.method.toUpperCase(),
    url: { raw: args.url },
    header: (args.headers ?? []).map((header) => ({ key: header.key, value: header.value })),
  };
  if (args.body !== undefined) {
    let language = args.bodyType;
    if (!language) {
      try {
        JSON.parse(args.body);
        language = 'json';
      } catch {
        language = 'text';
      }
    }
    request.body = { mode: 'raw', raw: args.body, options: { raw: { language } } };
  }
  if (args.bearerToken) {
    request.auth = {
      type: 'bearer',
      bearer: [{ key: 'token', value: args.bearerToken, type: 'string' }],
    };
  }
  return request;
}

/** The request that already has this name, wherever it sits, so saving again updates it. */
function existingRequest(collection: PostmanCollection, name: string): PostmanRequestItem | null {
  const found = walk(collection.item).find(
    (one) => !isFolder(one.item) && same(one.item.name, name),
  );
  return (found?.item as PostmanRequestItem | undefined) ?? null;
}

export const apiClientTools = [
  defineTool({
    name: 'api_list_collections',
    area: 'apiClient',
    title: 'List API collections',
    description: 'Every API Client collection with its requests, as "Folder / Request (METHOD)".',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'List the API Client collections' }),
    async run() {
      const summaries = await collectionStore.list();
      const result = [];
      for (const summary of summaries) {
        const collection = await collectionStore.get(summary.id).catch(() => null);
        const requests = collection
          ? walk(collection.item)
              .filter((one) => !isFolder(one.item))
              .map((one) => {
                const request = (one.item as PostmanRequestItem).request;
                return `${[...one.path, one.item.name].join(' / ')} (${request.method ?? 'GET'})`;
              })
          : [];
        result.push({
          id: summary.id,
          name: summary.name,
          requestCount: summary.requestCount,
          requests,
        });
      }
      return { data: result };
    },
  }),

  defineTool({
    name: 'api_get_collection',
    area: 'apiClient',
    title: 'Read an API collection',
    description:
      'One collection in full: its variables, and each folder and request with method, address, headers and body.',
    risk: 'read',
    input: z.object({ collection: collectionArg }),
    preview: (args) => ({ title: `Read the ${args.collection} collection` }),
    async run(args) {
      const summary = await findCollection(args.collection);
      const collection = await collectionStore.get(summary.id);
      const shape = (items: PostmanItem[]): unknown[] =>
        items.map((item) =>
          isFolder(item)
            ? { id: item.id, folder: item.name, items: shape(item.item) }
            : {
                id: item.id,
                name: item.name,
                method: item.request.method ?? 'GET',
                url: urlText(item.request),
                headers: headersOf(item.request),
                body: item.request.body?.raw,
                auth: item.request.auth?.type,
              },
        );
      return {
        data: {
          id: summary.id,
          name: summary.name,
          variables: (collection.variable ?? []).map((one) => ({ key: one.key, value: one.value })),
          items: shape(collection.item),
        },
      };
    },
  }),

  defineTool({
    name: 'api_create_collection',
    area: 'apiClient',
    title: 'Add an API collection',
    description: 'Adds an empty collection to the API Client.',
    risk: 'write',
    input: z.object({ name: z.string().min(1).max(200) }),
    preview: (args) => ({ title: `Add the ${args.name} collection` }),
    async run(args) {
      const summary = await collectionStore.create(args.name);
      return { text: `Added the ${summary.name} collection (id ${summary.id}).` };
    },
  }),

  defineTool({
    name: 'api_create_folder',
    area: 'apiClient',
    title: 'Add a folder to a collection',
    description: 'Adds a folder to a collection, at the top or inside another folder.',
    risk: 'write',
    input: z.object({
      collection: collectionArg,
      name: z.string().min(1).max(200),
      parentFolder: z.string().optional().describe('The folder to put it in, by name or id.'),
    }),
    preview: (args) => ({ title: `Add the ${args.name} folder to ${args.collection}` }),
    async run(args) {
      const summary = await findCollection(args.collection);
      const parentId = args.parentFolder
        ? findItem(await collectionStore.get(summary.id), args.parentFolder).item.id
        : null;
      const { folderId } = await collectionStore.createFolder(summary.id, parentId, args.name);
      return { text: `Added the ${args.name} folder to ${summary.name} (id ${folderId}).` };
    },
  }),

  defineTool({
    name: 'api_save_request',
    area: 'apiClient',
    title: 'Add or update an API request',
    description:
      'Saves a request in a collection, for example a sample login request to test with. A request with the same name is updated; otherwise it is added, in the given folder when there is one.',
    risk: 'write',
    input: requestInput,
    async preview(args) {
      const summary = await findCollection(args.collection).catch(() => null);
      const existing = summary
        ? existingRequest(await collectionStore.get(summary.id), args.name)
        : null;
      const where = summary?.name ?? args.collection;
      return previewOf(
        `${existing ? 'Update' : 'Add'} ${args.name} ${existing ? 'in' : 'to'} ${where}`,
        buildRequest(args),
      );
    },
    async run(args) {
      let summary = await findCollection(args.collection).catch((error) => {
        if (!args.createCollection) throw error;
        return null;
      });
      summary ??= await collectionStore.create(args.collection);
      const collection = await collectionStore.get(summary.id);
      const existing = existingRequest(collection, args.name);
      let parentId: string | null = null;
      if (!existing && args.folder) {
        const folder = walk(collection.item).find(
          (one) => isFolder(one.item) && same(one.item.name, args.folder ?? ''),
        );
        parentId =
          folder?.item.id ??
          (await collectionStore.createFolder(summary.id, null, args.folder)).folderId;
      }
      const item: PostmanRequestItem = {
        ...(existing ?? {}),
        id: existing?.id ?? randomUUID(),
        name: existing?.name ?? args.name,
        request: buildRequest(args),
      };
      await collectionStore.saveRequest({ collectionId: summary.id, parentId, item });
      return {
        text: `${existing ? 'Updated' : 'Added'} ${item.name} ${existing ? 'in' : 'to'} ${summary.name}${args.folder && !existing ? ` / ${args.folder}` : ''} (id ${item.id}).`,
      };
    },
  }),

  defineTool({
    name: 'api_remove_item',
    area: 'apiClient',
    title: 'Delete an API request or folder',
    description: 'Deletes a request, or a folder with everything in it, from a collection.',
    risk: 'sensitive',
    input: z.object({
      collection: collectionArg,
      item: z.string().min(1).describe('The request or folder, by name or id.'),
    }),
    async preview(args) {
      const summary = await findCollection(args.collection);
      const { item } = findItem(await collectionStore.get(summary.id), args.item);
      return {
        title: `Delete ${item.name} from ${summary.name}`,
        summary: isFolder(item) ? 'The folder and everything in it are deleted.' : undefined,
      };
    },
    async run(args) {
      const summary = await findCollection(args.collection);
      const { item } = findItem(await collectionStore.get(summary.id), args.item);
      await collectionStore.removeItem(summary.id, item.id);
      return { text: `Deleted ${item.name} from ${summary.name}.` };
    },
  }),

  defineTool({
    name: 'api_send_request',
    area: 'apiClient',
    title: 'Send an API request',
    description:
      "Sends a saved request with its collection's variables, auth and scripts, and returns the status, time, headers, body and test results.",
    risk: 'sensitive',
    input: z.object({
      collection: collectionArg,
      request: z.string().min(1).describe('The request, by name or id.'),
    }),
    async preview(args) {
      const summary = await findCollection(args.collection);
      const { item } = findItem(await collectionStore.get(summary.id), args.request);
      if (isFolder(item)) throw new Error(`${item.name} is a folder, not a request.`);
      return previewOf(`Send ${item.name}`, item.request);
    },
    async run(args) {
      const summary = await findCollection(args.collection);
      const { item } = findItem(await collectionStore.get(summary.id), args.request);
      if (isFolder(item)) throw new Error(`${item.name} is a folder, not a request.`);
      const result = await executeApiRequest({
        requestId: randomUUID(),
        request: item.request,
        events: item.event,
        name: item.name,
        collectionId: summary.id,
        itemId: item.id,
      });
      if (!result.response) {
        return { text: `No response: ${result.error ?? 'the request did not complete.'}` };
      }
      const { response } = result;
      const body =
        response.bodyEncoding === 'base64'
          ? `(${response.size.body} bytes of ${response.mime || 'binary data'})`
          : response.body.slice(0, MAX_BODY_SHOWN);
      return {
        data: {
          status: response.status,
          statusText: response.statusText,
          timeMs: Math.round(response.timings.total),
          headers: response.headers,
          body,
          bodyTruncated: response.bodyTruncated || response.body.length > MAX_BODY_SHOWN,
          tests: result.tests.map((test) => ({
            name: test.name,
            passed: test.passed,
            error: test.error,
          })),
          scriptErrors: result.scriptErrors,
        },
      };
    },
  }),
];
