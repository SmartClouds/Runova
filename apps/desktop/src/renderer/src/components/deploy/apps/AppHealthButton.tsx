import type { StackDetails } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Link, useNavigate } from 'react-router-dom';
import { HealthStatusChip } from '@/components/health/HealthStatusChip';
import { healthAddHref } from '@/components/health/healthIntent';
import { useAppHealthTarget } from '@/components/health/useAppHealthTarget';
import { HeartPulse } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { appHealthUrl } from '@/lib/deploy/apps/routes';
import { useSites } from '../sites/hooks';

/**
 * The app's health check on Monitoring. With none yet it opens the add dialog there, already
 * filled in with the app's name, project and address. Once one is linked it shows its state and
 * opens it instead, so an app is not watched twice by accident.
 */
export function AppHealthButton({
  serverId,
  serverHost,
  details,
  signedIn,
}: {
  serverId: string;
  /** The server's address, for an app that is reached on a port rather than a domain. */
  serverHost: string;
  details: StackDetails;
  signedIn: boolean;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const stack = details.stack;
  const linked = useAppHealthTarget(serverId, stack.id);
  const sites = useSites(serverId, signedIn);

  if (linked.isPending) return null;

  if (linked.target) {
    return (
      <Button asChild size="sm" variant="soft">
        <Link to={`/monitoring?target=${encodeURIComponent(linked.target.id)}`}>
          <HeartPulse className="h-3.5 w-3.5" /> Health check
          <HealthStatusChip state={linked.target.state} className="-my-1" />
        </Link>
      </Button>
    );
  }

  function add(): void {
    const address = appHealthUrl(details, sites.data, serverHost);
    navigate(
      healthAddHref({
        name: stack.name,
        url: address?.url,
        allowInsecure: address?.insecure,
        projectId: stack.source?.projectId,
        environmentId: stack.source?.environmentId,
        serverLink: `ssh:${serverId}`,
        appLink: { serverId, stackId: stack.id },
        appName: stack.name,
      }),
    );
  }

  return (
    // Waits for Websites, so a domain is not passed over for the server's own address.
    <Button size="sm" variant="soft" disabled={signedIn && sites.isPending} onClick={add}>
      <HeartPulse className="h-3.5 w-3.5" /> Add health check
    </Button>
  );
}
