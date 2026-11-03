import { type HostToMain, toCloneable } from './hostProtocol';

/**
 * Entry point of the utility process that runs API requests (see hostClient.ts for why it is a
 * process of its own). It says it is alive before it loads anything heavy, so main can tell a
 * process that never started from one that is still reading Postman's runtime off a slow disk.
 * The relay itself is in runnerHostMain.ts, loaded once that message is out.
 */

const port = process.parentPort;

function post(message: HostToMain): void {
  try {
    port.postMessage(message);
  } catch {
    // Something in it could not be cloned; a plain JSON copy always can.
    port.postMessage(toCloneable(message));
  }
}

process.on('uncaughtException', (error) => {
  post({ type: 'fatal', error: error.message });
});

post({ type: 'alive' });

import('./runnerHostMain').then(
  ({ startHost }) => startHost(port, post),
  (error: unknown) => {
    post({
      type: 'fatal',
      error: `The request engine could not load: ${error instanceof Error ? error.message : String(error)}`,
    });
  },
);
