import { coreErrorMessage } from '@shared/coreErrors';
import type {
  CoreDomainMode,
  CoreDomainStatus,
  JobInfo,
  SiteInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployCoreDomainInfo } from '@shared/deployCoreDomainTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CloudflareMark } from '@/components/cloudflare/CloudflareMark';
import { ArrowRight, Globe, Lock, Pencil, Power, RefreshCw, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { useFinishedOnce } from '@/stores/deployFollowedJobStore';
import { Notice } from '../../deployKit';
import { useDeployConnection } from '../../overview/hooks';
import { JobLogDialog } from '../../overview/JobLogDialog';
import { useProofStepUp } from '../../overview/useProofStepUp';
import { IssueDialog } from '../../sites/CertificateDialogs';
import { CARD_BODY, LoadFailure, SecurityCard } from '../SecurityCard';
import { CoreDomainDetails, certificateProblem } from './CoreDomainDetails';
import { CoreDomainForm } from './CoreDomainForm';

/**
 * The core domain (E44) for one server: the core behind a domain in nginx, so the app reaches it
 * without SSH and without a port of its own. It needs nginx installed and running. Straight to the
 * server, the domain is DNS only and nginx asks for this computer's device certificate. Through
 * Cloudflare, the record is proxied (the origin lock can stay on) and each request is signed with
 * the device key instead. Everyone sees how it stands; Owners turn it on (with a step-up), change
 * it and turn it off; Admins get its certificate.
 */
export function CoreDomainCard({
  server,
  owner,
  admin,
}: {
  server: DeployServer;
  owner: boolean;
  admin: boolean;
}): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const [, setParams] = useSearchParams();
  const info = useQuery({
    queryKey: queryKeys.deployCoreDomain(serverId),
    queryFn: () => window.runova.deployCoreDomain.status(serverId),
    retry: false,
  });
  const connection = useDeployConnection(serverId);
  const stepUp = useProofStepUp(server);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'off' | 'check' | 'origin' | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [job, setJob] = useState<JobInfo | null>(null);
  const jobFinished = useFinishedOnce(serverId, () => void refresh());

  function settled(next: DeployCoreDomainInfo): void {
    queryClient.setQueryData(queryKeys.deployCoreDomain(serverId), next);
  }

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.deployCoreDomain(serverId) });
  }

  async function save(domain: string, sources: string[], mode: CoreDomainMode): Promise<void> {
    setBusy('save');
    try {
      const next = await stepUp.run(
        (proof) =>
          window.runova.deployCoreDomain.enable({ serverId, domain, sources, mode, ...proof }),
        'put the core behind a domain',
      );
      if (!next) return;
      settled(next);
      setEditing(false);
      toast.success(`The core domain is on: ${next.status.domain ?? domain}.`);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function turnOff(): Promise<void> {
    const current = info.data?.status;
    if (!current) return;
    const confirmed = await confirmDialog({
      title: `Turn off the core domain on ${server.nickname}?`,
      description: `nginx stops passing ${current.domain ?? 'the domain'} to the core, and every computer goes back to direct TLS or SSH. Computers that can use neither lose access to the core.`,
      confirmLabel: 'Turn off',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setBusy('off');
    try {
      settled(await window.runova.deployCoreDomain.disable(serverId));
      toast.success('The core domain is off.');
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  /**
   * A Cloudflare Origin CA certificate for the domain (E14 T5): the core makes the key, Cloudflare
   * signs it with the account that holds the domain. Only Cloudflare trusts it, which is all it
   * takes behind the proxy, and it never needs renewing.
   */
  async function originCertificate(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Install a Cloudflare Origin CA certificate?',
      description:
        "Cloudflare signs a certificate for a key this server makes; the key never leaves it. Only Cloudflare trusts it, so keep the record proxied and the zone's SSL/TLS mode on Full (strict).",
      confirmLabel: 'Make and install it',
    });
    if (!confirmed) return;
    setBusy('origin');
    try {
      const result = await window.runova.cloudflareServer.originCertificate({
        serverId,
        siteId: info.data?.status.siteId ?? 'runova-core',
      });
      if (result.problems.length > 0) toast.error(result.problems.join(' '));
      else toast.success('Origin CA certificate installed and live.');
      await refresh();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function check(): Promise<void> {
    setBusy('check');
    try {
      const next = await window.runova.deployCoreDomain.check(serverId);
      settled(next);
      if (next.check?.ok) toast.success('This computer reached the core through the domain.');
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  let body: React.ReactNode;
  if (info.isPending) {
    body = (
      <div className={`${CARD_BODY} space-y-3`} aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex gap-3">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 flex-1" />
          </div>
        ))}
      </div>
    );
  } else if (info.isError) {
    body = (
      <LoadFailure message={coreErrorMessage(info.error)} onRetry={() => void info.refetch()} />
    );
  } else {
    const { status } = info.data;
    const blocked = blockedBy(status);
    const mode = status.mode ?? 'direct';
    const throughCloudflare = mode === 'cloudflare';
    const needsCertificate =
      status.enabled && (!status.certificate || certificateProblem(status) !== null);
    body = (
      <div className={`${CARD_BODY} space-y-4`}>
        {blocked === 'nginx' && (
          <Notice tone="warning" role="status">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium text-foreground">
                  {status.nginxInstalled ? 'nginx is not running' : 'nginx is not installed'}
                </p>
                <p className="text-muted-foreground">
                  The core domain is served by nginx, so it has to be installed and running on{' '}
                  {server.nickname} first. Websites installs it and shows how it runs.
                </p>
              </div>
              <Button
                size="sm"
                variant="soft"
                onClick={() => setParams({ server: serverId, view: 'websites' })}
              >
                Open Websites <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Notice>
        )}
        {status.originLocked && !(status.enabled && throughCloudflare) && (
          <Notice tone={status.enabled ? 'warning' : 'primary'} role="status">
            <p className="font-medium text-foreground">The Cloudflare origin lock is on</p>
            <p className="text-muted-foreground">
              Only Cloudflare reaches ports 80 and 443, so the core domain has to go through
              Cloudflare too: choose Through Cloudflare and keep the record proxied.
            </p>
          </Notice>
        )}
        <CoreDomainDetails info={info.data} connection={connection} />
        {status.enabled && needsCertificate && (
          <Notice tone="primary" icon={Lock}>
            <div className="flex flex-wrap items-start gap-3">
              <p className="min-w-0 flex-1 text-muted-foreground">
                {throughCloudflare
                  ? `${status.domain} needs a certificate Cloudflare trusts before the app can use it. A Cloudflare Origin CA certificate is the simplest (Cloudflare signs it, and it never needs renewing); one from Let's Encrypt works too.`
                  : `${status.domain} needs a certificate from Let's Encrypt before the app can use it. Let's Encrypt checks the domain over port 80, so its DNS record has to point here already.`}
              </p>
              {admin && status.domain && (
                <div className="flex flex-wrap gap-2">
                  {throughCloudflare && (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void originCertificate()}
                    >
                      {busy === 'origin' ? (
                        <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                      ) : (
                        <CloudflareMark className="h-3.5 w-3.5" />
                      )}
                      Cloudflare Origin CA
                    </Button>
                  )}
                  <Button
                    size="sm"
                    {...(throughCloudflare ? { variant: 'soft' as const } : {})}
                    disabled={busy !== null}
                    onClick={() => setIssuing(true)}
                  >
                    <Lock className="h-3.5 w-3.5" /> Get a certificate
                  </Button>
                </div>
              )}
            </div>
          </Notice>
        )}
        {!status.enabled && (
          <p className="text-xs text-muted-foreground">
            Point an A (and AAAA, if the server has IPv6) record for a domain or subdomain of yours
            at this server. Straight to the server, keep Cloudflare's proxy off for it (the grey
            cloud, DNS only). Through Cloudflare, turn the proxy on (the orange cloud) and set the
            zone's SSL/TLS mode to Full (strict). Ports 80 and 443 have to be open in the firewall,
            to Cloudflare alone while the origin lock is on.
          </p>
        )}
        {status.enabled && status.ready && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="soft" disabled={busy !== null} onClick={() => void check()}>
              {busy === 'check' ? (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Check from this computer
            </Button>
          </div>
        )}
        {!owner ? (
          <p className="text-xs text-muted-foreground">Only an Owner can change the core domain.</p>
        ) : editing || !status.enabled ? (
          <CoreDomainForm
            initialDomain={status.domain ?? ''}
            initialSources={status.sources}
            initialMode={mode}
            originLocked={status.originLocked}
            busy={busy === 'save'}
            disabled={blocked !== null}
            submitLabel={status.enabled ? 'Save' : 'Turn on the core domain'}
            onSubmit={(domain, sources, chosen) => void save(domain, sources, chosen)}
            {...(status.enabled ? { onCancel: () => setEditing(false) } : {})}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="soft"
              disabled={busy !== null}
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3.5 w-3.5" /> Change domain, mode or sources
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null}
              onClick={() => void turnOff()}
            >
              <Power className="h-3.5 w-3.5" /> Turn off
            </Button>
          </div>
        )}
        {status.enabled && status.domain && (
          <IssueDialog
            serverId={serverId}
            site={siteFor(status, status.domain)}
            open={issuing}
            onClose={() => setIssuing(false)}
            onStarted={(started) => {
              setIssuing(false);
              setJob(started);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <SecurityCard
      icon={<Globe />}
      title="Core domain"
      description="Reach the core at a domain or subdomain of your own through nginx, with no SSH and no extra port, straight to the server or through Cloudflare. Each computer proves its device key on every request. When the domain does not answer, the app tries direct TLS and then SSH."
    >
      {body}
      <JobLogDialog
        serverId={serverId}
        job={job}
        canCancel={admin}
        onClose={() => setJob(null)}
        onFinished={jobFinished}
      />
      {stepUp.dialog}
    </SecurityCard>
  );
}

/**
 * What keeps the core domain from being turned on or changed now, if anything. The origin lock
 * only rules out Straight to the server, which the form handles.
 */
function blockedBy(status: CoreDomainStatus): 'nginx' | null {
  if (!status.nginxInstalled || !status.nginxRunning) return 'nginx';
  return null;
}

/** The reserved site as the certificate dialog reads it: its id and its one domain. */
function siteFor(status: CoreDomainStatus, domain: string): SiteInfo {
  return {
    settings: {
      id: status.siteId,
      domains: [domain],
      upstream: { kind: 'runovaCore', verifyCertificate: true, sendUpstreamHost: false },
      websocket: true,
      gzip: false,
      http2: false,
      redirectToHttps: true,
    },
    applied: status.siteApplied,
    createdAtUnixMs: 0,
    updatedAtUnixMs: 0,
    ...(status.certificate ? { certificate: status.certificate } : {}),
  };
}
