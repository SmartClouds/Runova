import runtime from 'postman-runtime';
import { postmanEngine } from './engine/postmanEngine';
import type { EngineRun } from './engine/types';
import { type HostToMain, parseMainMessage, readyMessage, toCloneable } from './hostProtocol';

/**
 * Entry point of the utility process that runs API requests (see hostClient.ts for why it is a
 * process of its own). It only relays: main sends runs and cancels, this answers with events and
 * a summary per run.
 */

const port = process.parentPort;
const runs = new Map<string, EngineRun>();

function post(message: HostToMain): void {
  try {
    port.postMessage(message);
  } catch {
    // Something in it could not be cloned; a plain JSON copy always can.
    port.postMessage(toCloneable(message));
  }
}

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

process.on('uncaughtException', (error) => {
  post({ type: 'fatal', error: error.message });
});

post(readyMessage(runtime));
