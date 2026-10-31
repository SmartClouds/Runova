import type { DeployDirectTlsInfo } from '@shared/deployDirectTlsTypes';
import type { DeployConnection } from '@shared/deployTypes';
import { toast } from 'sonner';
import { CircleCheck, CircleX, Copy, TriangleAlert } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { ago } from '../format';

/**
 * How direct TLS stands: on or off (in words and a mark, never colour alone), the port, who may
 * connect, the server key's pin and when this computer took it over SSH, and what the live
 * connection rides on right now.
 */

function Row({ term, children }: { term: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="pt-0.5 text-xs text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function stateOf(info: DeployDirectTlsInfo): {
  label: string;
  tone: 'on' | 'off' | 'problem';
} {
  const { status } = info;
  if (!status.enabled) return { label: 'Off', tone: 'off' };
  if (!status.listening) return { label: 'On, but the port is not open', tone: 'problem' };
  return { label: `On, listening on port ${status.port}`, tone: 'on' };
}

function via(connection: DeployConnection | undefined): string {
  if (!connection || connection.state !== 'online') return 'Not connected right now';
  switch (connection.transport) {
    case 'direct-tls':
      return 'Connected over direct TLS';
    case 'core-domain':
      return 'Connected through the core domain';
    case 'streamlocal':
    case 'bridge':
      return 'Connected over SSH';
    case 'dev-tcp':
      return 'Connected over loopback (DevHost)';
    default:
      return 'Connected';
  }
}

export function DirectTlsDetails({
  info,
  connection,
}: {
  info: DeployDirectTlsInfo;
  connection: DeployConnection | undefined;
}): React.JSX.Element {
  const { status, pinned } = info;
  const state = stateOf(info);
  const Mark = state.tone === 'on' ? CircleCheck : state.tone === 'off' ? CircleX : TriangleAlert;
  const chipTone = state.tone === 'on' ? 'success' : state.tone === 'off' ? 'neutral' : 'warning';

  async function copyPin(): Promise<void> {
    try {
      await navigator.clipboard.writeText(status.pin);
      toast.success('Pin copied.');
    } catch {
      toast.error('Could not copy the pin.');
    }
  }

  return (
    <dl className="settings-rows" aria-label="Direct TLS details">
      <Row term="Status">
        <Chip tone={chipTone}>
          <Mark aria-hidden />
          {state.label}
        </Chip>
        {status.error && <p className="mt-1 text-xs text-warning">{status.error}</p>}
      </Row>
      {status.enabled && (
        <Row term="Address">
          <span className="font-mono text-xs">
            {info.host}:{status.port}
          </span>
        </Row>
      )}
      <Row term="Allowed from">
        {status.sources.length === 0 ? (
          'Any address (a client certificate is still required)'
        ) : (
          <ul className="space-y-0.5 font-mono text-xs">
            {status.sources.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        )}
      </Row>
      <Row term="Server key pin">
        <div className="flex items-start gap-2">
          <code className="min-w-0 break-all rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-xs">
            sha256/{status.pin}
          </code>
          <SimpleTooltip label="Copy the pin">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="-my-1 shrink-0"
              aria-label="Copy the pin"
              onClick={() => void copyPin()}
            >
              <Copy />
            </Button>
          </SimpleTooltip>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {pinned && !info.pinChanged
            ? `Pinned on this computer ${ago(pinned.pinnedAt)}, read over SSH. The certificate is valid until ${new Date(status.certificateNotAfterUnixMs).toLocaleDateString()}.`
            : 'Read over SSH just now.'}
        </p>
      </Row>
      <Row term="This computer">
        {pinned?.enabled && !info.pinChanged
          ? 'Tries direct TLS first, then SSH.'
          : 'Uses SSH only.'}{' '}
        <span className="text-muted-foreground">{via(connection)}.</span>
      </Row>
      {status.changedBy && status.changedAtUnixMs !== undefined && (
        <Row term="Last changed">
          {ago(status.changedAtUnixMs)} by {status.changedBy}
        </Row>
      )}
    </dl>
  );
}
