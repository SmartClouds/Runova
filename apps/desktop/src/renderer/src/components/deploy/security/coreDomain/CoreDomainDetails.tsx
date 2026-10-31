import type { CoreDomainStatus } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployCoreDomainCheck, DeployCoreDomainInfo } from '@shared/deployCoreDomainTypes';
import type { DeployConnection } from '@shared/deployTypes';
import { CircleCheck, CircleX, TriangleAlert } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { ago } from '../format';

/**
 * How the core domain stands: on or off (in words and a mark, never colour alone), the address,
 * who nginx lets in, the domain's certificate, what this computer does with it and what the live
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

export function stateOf(status: CoreDomainStatus): {
  label: string;
  tone: 'on' | 'off' | 'problem';
} {
  if (!status.enabled) return { label: 'Off', tone: 'off' };
  if (status.ready)
    return { label: `On, answering at ${status.domain ?? 'its domain'}`, tone: 'on' };
  if (!status.listening)
    return { label: "On, but the core's port for nginx is not open", tone: 'problem' };
  if (!status.siteApplied) return { label: 'On, but nginx does not serve it yet', tone: 'problem' };
  if (!status.certificate) return { label: 'On, waiting for a certificate', tone: 'problem' };
  return { label: 'On, but not ready yet', tone: 'problem' };
}

/** Why a certificate the domain has cannot carry the app's connection, or null when it can. */
export function certificateProblem(status: CoreDomainStatus): string | null {
  const certificate = status.certificate;
  if (!certificate) return null;
  if (certificate.state === 'expired') return 'The certificate has expired. Issue a new one.';
  if (certificate.state === 'revoked') return 'The certificate was revoked. Issue a new one.';
  if (certificate.staging) {
    return "It comes from Let's Encrypt's staging CA, which this computer does not trust. Issue a real one.";
  }
  if (certificate.source === 'cloudflareOrigin') {
    return "A Cloudflare origin certificate is only trusted by Cloudflare's proxy, and the core domain is reached directly. Issue one from Let's Encrypt instead.";
  }
  return null;
}

/** What a failed check from this computer means, in words. */
export function checkMessage(check: DeployCoreDomainCheck): string {
  if (check.ok) return 'This computer reached the core through the domain.';
  if (check.problem === 'cloudflare-proxy') {
    return "Cloudflare answers for this domain, so this computer's device certificate never reaches the server. In Cloudflare's DNS settings, turn the proxy off for this record (the grey cloud, DNS only), wait a minute and check again.";
  }
  return check.message;
}

function via(connection: DeployConnection | undefined): string {
  if (!connection || connection.state !== 'online') return 'Not connected right now';
  switch (connection.transport) {
    case 'core-domain':
      return 'Connected through the core domain';
    case 'direct-tls':
      return 'Connected over direct TLS';
    case 'streamlocal':
    case 'bridge':
      return 'Connected over SSH';
    case 'dev-tcp':
      return 'Connected over loopback (DevHost)';
    default:
      return 'Connected';
  }
}

export function CoreDomainDetails({
  info,
  connection,
}: {
  info: DeployCoreDomainInfo;
  connection: DeployConnection | undefined;
}): React.JSX.Element {
  const { status, route, check } = info;
  const state = stateOf(status);
  const Mark = state.tone === 'on' ? CircleCheck : state.tone === 'off' ? CircleX : TriangleAlert;
  const chipTone = state.tone === 'on' ? 'success' : state.tone === 'off' ? 'neutral' : 'warning';
  const certificate = status.certificate;
  const unusable = certificateProblem(status);

  return (
    <dl className="settings-rows" aria-label="Core domain details">
      <Row term="Status">
        <Chip tone={chipTone}>
          <Mark aria-hidden />
          {state.label}
        </Chip>
        {status.error && <p className="mt-1 text-xs text-warning">{status.error}</p>}
      </Row>
      {status.enabled && status.domain && (
        <Row term="Address">
          <span className="font-mono text-xs">https://{status.domain}</span>
        </Row>
      )}
      {status.enabled && (
        <Row term="Allowed from">
          {status.sources.length === 0 ? (
            "Any address (this computer's device certificate is still required)"
          ) : (
            <ul className="space-y-0.5 font-mono text-xs">
              {status.sources.map((source) => (
                <li key={source}>{source}</li>
              ))}
            </ul>
          )}
        </Row>
      )}
      {status.enabled && (
        <Row term="Certificate">
          {certificate
            ? `${certificate.issuer}, valid until ${new Date(certificate.notAfterUnixMs).toLocaleDateString()}.`
            : 'None yet. The domain only answers over HTTPS once it has one.'}
          {unusable && <p className="mt-1 text-xs text-warning">{unusable}</p>}
        </Row>
      )}
      <Row term="This computer">
        {route?.enabled
          ? 'Tries the core domain first, then direct TLS, then SSH.'
          : status.ready
            ? 'Does not use the domain until a check from here passes.'
            : 'Uses direct TLS or SSH.'}{' '}
        <span className="text-muted-foreground">{via(connection)}.</span>
        {check && (
          <p className={`mt-1 text-xs ${check.ok ? 'text-muted-foreground' : 'text-warning'}`}>
            {checkMessage(check)} Checked {ago(check.checkedAt)}.
          </p>
        )}
      </Row>
      {status.changedBy && status.changedAtUnixMs !== undefined && (
        <Row term="Last changed">
          {ago(status.changedAtUnixMs)} by {status.changedBy}
        </Row>
      )}
    </dl>
  );
}
