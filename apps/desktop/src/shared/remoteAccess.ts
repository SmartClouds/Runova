import type { AccountStatus } from './accountTypes';

/** Why a remote control action was refused, in the words the person reads. */
export const REMOTE_SIGN_IN_ERROR = 'Sign in to Runova to use remote control.';

/**
 * Remote control (Anywhere, and hosting or connecting on the local network) needs a live Runova
 * sign-in. A session the server has refused does not count, since it can no longer be used.
 */
export function canUseRemote(status: AccountStatus): boolean {
  return status.state === 'signed-in' && !status.needsSignIn;
}
