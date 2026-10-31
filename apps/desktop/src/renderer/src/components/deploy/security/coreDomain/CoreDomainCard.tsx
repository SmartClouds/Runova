import { coreErrorMessage } from '@shared/coreErrors';
import type {
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
 * without SSH and without a port of its own. It needs nginx installed and running, and the domain
 * pointing straight at the server (DNS only), since nginx asks for this computer's device
 * certificate and a proxy in front would never pass it on. Everyone sees how it stands; Owners
 * turn it on (with a step-up), change it and turn it off; Admins get its certificate.
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
  const [busy, setBusy] = useState<'save' | 'off' | 'check' | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [job, setJob] = useState<JobInfo | null>(null);
  const jobFinished = useFinishedOnce(serverId, () => void refresh());

  function settled(next: DeployCoreDomainInfo): void {
    queryClient.setQueryData(queryKeys.deployCoreDomain(serverId), next);
  }

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.deployCoreDomain(serverId) });
  }

  async function save(domain: string, sources: string[]): Promise<void> {
    setBusy('save');
    try {
      const next = await stepUp.run(
        (proof) => window.runova.deployCoreDomain.enable({ serverId, domain, sources, ...proof }),
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
        {blocked === 'originLock' && (
          <Notice tone="warning" role="status">
            <p className="font-medium text-foreground">The Cloudflare origin lock is on</p>
            <p className="text-muted-foreground">
              It lets only Cloudflare reach ports 80 and 443, and the core domain has to be reached
              directly. Turn the origin lock off under Websites first.
            </p>
          </Notice>
        )}
        <CoreDomainDetails info={info.data} connection={connection} />
        {status.enabled && needsCertificate && (
          <Notice tone="primary" icon={Lock}>
            <div className="flex flex-wrap items-start gap-3">
              <p className="min-w-0 flex-1 text-muted-foreground">
                {status.domain} needs a certificate from Let's Encrypt before the app can use it.
                Let's Encrypt checks the domain over port 80, so its DNS record has to point here
                already.
              </p>
              {admin && status.domain && (
                <Button size="sm" disabled={busy !== null} onClick={() => setIssuing(true)}>
                  <Lock className="h-3.5 w-3.5" /> Get a certificate
                </Button>
              )}
            </div>
          </Notice>
        )}
        {!status.enabled && (
          <p className="text-xs text-muted-foreground">
            Point an A (and AAAA, if the server has IPv6) record for the domain at this server. On
            Cloudflare, keep the proxy off for it (the grey cloud, DNS only): nginx asks for this
            computer's device certificate, and a proxy in front never passes it on. Ports 80 and 443
            have to be open in the firewall.
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
            busy={busy === 'save'}
            disabled={blocked !== null}
            submitLabel={status.enabled ? 'Save' : 'Turn on the core domain'}
            onSubmit={(domain, sources) => void save(domain, sources)}
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
              <Pencil className="h-3.5 w-3.5" /> Change domain or sources
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
      description="Reach the core at its own domain through nginx, with no SSH and no extra port. nginx asks each computer for its device certificate and the core checks it on every request. When the domain does not answer, the app tries direct TLS and then SSH."
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

/** What keeps the mode from being turned on or changed now, if anything. */
function blockedBy(status: CoreDomainStatus): 'nginx' | 'originLock' | null {
  if (!status.nginxInstalled || !status.nginxRunning) return 'nginx';
  if (status.originLocked) return 'originLock';
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
