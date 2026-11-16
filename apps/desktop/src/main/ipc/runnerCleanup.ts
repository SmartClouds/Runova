import type { RunnerMachineLink } from '@runova/core';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { z } from 'zod';
import type { RunnerCleanupProgress } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { createRealRunnerCleanup } from '../pipelines/runnerCleanup/deps';
import { machineKeyOf, type RunnerCleanupService } from '../pipelines/runnerCleanup/service';
import { sendToContents } from './send';

/**
 * The window's side of the runner cleanup (E104). It deletes things on a runner machine, so it
 * answers the main window only, and a request can name a machine link, a scan and item ids,
 * nothing else. The service checks the ids against the scan it holds before anything runs.
 */

export interface RunnerCleanupHandlerOptions {
  guard?: (event: IpcMainInvokeEvent) => boolean;
  /** For tests. The real one is built on first use. */
  service?: RunnerCleanupService;
}

const linkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local') }),
  z.strictObject({ kind: z.literal('ssh'), serverId: z.string().min(1).max(200) }),
]);

const itemId = z.string().regex(/^[a-z0-9-]{1,40}$/);

const cleanSchema = z.strictObject({
  link: linkSchema,
  scanId: z.string().min(1).max(100),
  itemIds: z.array(itemId).max(500),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`That ${label} is not valid.`);
  return result.data;
}

export function registerRunnerCleanupHandlers(options: RunnerCleanupHandlerOptions = {}): void {
  let built: RunnerCleanupService | null = options.service ?? null;
  const service = (): RunnerCleanupService => {
    built ??= createRealRunnerCleanup();
    return built;
  };

  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (options.guard && !options.guard(event)) {
        throw new Error('Runner cleanup answers only the main window.');
      }
      return listener(event, ...args);
    });
  };

  const progressTo =
    (event: IpcMainInvokeEvent) =>
    (progress: RunnerCleanupProgress): void =>
      sendToContents(event.sender, IPC.runnerCleanup.onProgress, progress);

  handle(IPC.runnerCleanup.scan, (event, rawLink) => {
    const link: RunnerMachineLink = parse(linkSchema, rawLink, 'machine');
    const send = progressTo(event);
    const machine = machineKeyOf(link);
    return service().scan(link, (step) => send({ machine, phase: 'scan', step }));
  });

  handle(IPC.runnerCleanup.clean, (event, rawRequest) => {
    const request = parse(cleanSchema, rawRequest, 'cleanup');
    const send = progressTo(event);
    const machine = machineKeyOf(request.link);
    return service().clean(request, (outcome) => send({ machine, phase: 'clean', ...outcome }));
  });

  handle(IPC.runnerCleanup.cancel, (_event, rawLink) =>
    service().cancel(parse(linkSchema, rawLink, 'machine')),
  );

  handle(IPC.runnerCleanup.saveSchedule, (_event, rawLink, rawSchedule) =>
    // The schedule itself is checked by the service before it goes into any script.
    service().saveSchedule(parse(linkSchema, rawLink, 'machine'), rawSchedule),
  );

  handle(IPC.runnerCleanup.removeSchedule, (_event, rawLink) =>
    service().removeSchedule(parse(linkSchema, rawLink, 'machine')),
  );
}
