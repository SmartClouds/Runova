/** The parts of the remote manager that signing out needs. */
export interface RemoteSessions {
  stopHost(): void;
  closeSessionAndDisconnect(): void;
}

/**
 * Remote control needs a Runova sign-in, so signing out (or the server ending the session) stops
 * hosting and ends any outgoing session. The background agent is separate: it has its own
 * credentials and stays on until its owner turns it off.
 */
export function endRemoteOnSignOut(sessions: RemoteSessions): void {
  sessions.stopHost();
  sessions.closeSessionAndDisconnect();
}
