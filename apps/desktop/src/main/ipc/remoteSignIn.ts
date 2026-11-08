import type { IpcMainInvokeEvent } from 'electron';
import { canUseRemote, REMOTE_SIGN_IN_ERROR } from '../../shared/remoteAccess';
import { getAccountRuntime } from '../account/live';

/** Remote control needs a Runova sign-in; the screens ask first, and this holds anyway. */
export async function remoteSignedIn(): Promise<boolean> {
  return canUseRemote(await getAccountRuntime().status());
}

/** An IPC handler that refuses to run for someone not signed in to Runova. */
export function signedInOnly<Args extends unknown[], Result>(run: (...args: Args) => Result) {
  return async (_event: IpcMainInvokeEvent, ...args: Args): Promise<Awaited<Result>> => {
    if (!(await remoteSignedIn())) throw new Error(REMOTE_SIGN_IN_ERROR);
    return await run(...args);
  };
}
