import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted reply. A function is called when its request arrives and the response waits for it,
 * so a script can hold the AI back until something it depends on has really happened.
 */
export type FakeReply = string | (() => Promise<string>);

export interface FakeOllama {
  /** Goes in the `ollamaBaseUrl` setting. */
  url: string;
  /** Every prompt the app sent, oldest first. */
  prompts: string[];
  /** The base64 images attached to each of those prompts, empty when there were none. */
  images: string[][];
  /** Adds replies to the end of the script, for a test that learns what to say along the way. */
  say: (...replies: FakeReply[]) => void;
  close: () => Promise<void>;
}

/**
 * Stands in for Ollama's /api/chat so an AI task follows a fixed script. Each request gets the
 * next reply; once the script runs out, the task is told it's finished.
 */
export async function startFakeOllama(replies: FakeReply[]): Promise<FakeOllama> {
  const queue = [...replies];
  const prompts: string[] = [];
  const images: string[][] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', async () => {
      if (request.method !== 'POST' || request.url !== '/api/chat') {
        response.writeHead(404).end();
        return;
      }
      const { messages } = JSON.parse(body) as {
        messages: { content: string; images?: string[] }[];
      };
      prompts.push(messages.at(-1)?.content ?? '');
      images.push(messages.at(-1)?.images ?? []);
      const next = queue.shift() ?? 'FINISHED: out of script';
      let content: string;
      try {
        content = typeof next === 'string' ? next : await next();
      } catch (error) {
        // The task stops on a failed request, and the error says why in its history.
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    prompts,
    images,
    say: (...replies) => {
      queue.push(...replies);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
