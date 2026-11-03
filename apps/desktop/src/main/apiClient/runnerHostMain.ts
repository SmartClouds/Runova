import runtime from 'postman-runtime';
import { postmanEngine } from './engine/postmanEngine';
import type { EngineRun } from './engine/types';
import { type HostToMain, parseMainMessage, readyMessage } from './hostProtocol';

/**
 * The working half of the utility process that runs API requests (runnerHost.ts is the entry
 * point, and hostClient.ts says why it is a process of its own). Importing this loads Postman's
 * runtime, which is the slow part of starting up. After that it only relays: main sends runs and
 * cancels, this answers with events and a summary per run.
 */

type ParentPort = Electron.ParentPort;

export function startHost(port: ParentPort, post: (message: HostToMain) => void): void {
  const runs = new Map<string, EngineRun>();

  port.on('message', (event: { data: unknown }) => {
    const message = parseMainMessage(event.data);
    if (!message) return;

    if (message.type === 'cancel') {
      runs.get(message.runId)?.cancel();
      return;
    }

    const { runId, input } = message;
    try {
      const run = postmanEngine.run(input, (engineEvent) =>
        post({ type: 'event', runId, event: engineEvent }),
      );
      runs.set(runId, run);
      void run.done.then((summary) => {
        runs.delete(runId);
        post({ type: 'done', runId, summary });
      });
    } catch (error) {
      post({
        type: 'done',
        runId,
        summary: {
          error: error instanceof Error ? error.message : String(error),
          cancelled: false,
          environment: [],
          globals: [],
          collectionVariables: [],
        },
      });
    }
  });

  post(readyMessage(runtime));
}
