import { filesErrorCode } from '@shared/deployFilesErrors';
import { sshErrorCode } from '@shared/sshErrors';
import type { SshHostKeyStatus } from '@shared/sshHostKey';
import { promptHostKeyTrust } from '@/stores/hostKeyPromptStore';

/**
 * Where a host key lives and how a new one gets trusted. A server saved in Remote keeps its key
 * there; an FTP or SFTP site with a login of its own keeps its key itself (see
 * `fileSiteHostKeySource` in components/deploy/files/hostKey.ts).
 */
export interface HostKeyTrustSource {
  status(): Promise<SshHostKeyStatus>;
  trust(fingerprint: string): Promise<void>;
}

function savedServerSource(serverId: string): HostKeyTrustSource {
  return {
    status: () => window.runova.ssh.hostKeyStatus(serverId),
    trust: (fingerprint) => window.runova.ssh.trustHostKey(serverId, fingerprint),
  };
}

/**
 * SSH calls tag the failure `[ssh:host-key-changed]`, or `[ssh:host-key-unknown]` for a server
 * whose key was never trusted; FTP and SFTP site calls `[files:hostKeyChanged]`. A saved server
 * reached through an FTP or SFTP site reports a key never trusted as `[files:hostKeyUnknown]`; a
 * site with a login of its own trusts its first key in the site's form instead.
 */
function needsHostKeyTrust(error: unknown, savedServer: boolean): boolean {
  const ssh = sshErrorCode(error);
  if (ssh === 'host-key-changed' || ssh === 'host-key-unknown') return true;
  const files = filesErrorCode(error);
  return files === 'hostKeyChanged' || (savedServer && files === 'hostKeyUnknown');
}

/**
 * Runs an SSH connect and, when the server's host key changed or was never trusted, lets the
 * user decide. Nothing is sent to a server before its key is trusted. Only an explicit "trust"
 * stores the key, and main re-reads the key before storing it, so what gets trusted is the key
 * the user was shown.
 *
 * Shared by every place the app connects over SSH, so the question always looks the same. Pass a
 * saved server's id, or a source of its own for a key kept somewhere else.
 */
export async function withHostKeyTrust<T>(serverId: string, attempt: () => Promise<T>): Promise<T>;
export async function withHostKeyTrust<T>(
  source: HostKeyTrustSource,
  attempt: () => Promise<T>,
): Promise<T>;
export async function withHostKeyTrust<T>(
  target: string | HostKeyTrustSource,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!needsHostKeyTrust(error, typeof target === 'string')) throw error;
    const source = typeof target === 'string' ? savedServerSource(target) : target;

    const status = await source.status();
    // Someone trusted the new key while this connect was failing (another tab, say).
    if (status.stored === status.presented) return attempt();

    const trusted = await promptHostKeyTrust(status);
    if (!trusted) {
      const which = status.stored ? 'its new host key' : 'its host key';
      throw new Error(`Not connected to ${status.nickname}: ${which} was not trusted.`);
    }
    await source.trust(status.presented);
    return attempt();
  }
}
