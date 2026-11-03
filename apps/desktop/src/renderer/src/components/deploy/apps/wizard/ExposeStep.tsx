import type { ComposePortBinding } from '@runova/core';
import type { DeployStackPreview } from '@shared/deployStacksTypes';
import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Globe,
  Lock,
  LockOpen,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { SECTION_WELL } from '@/components/pageKit';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { bindingAddress, isPublicBinding } from '@/lib/deploy/apps/format';
import { describeHolder, type PortConflict } from '@/lib/deploy/apps/portConflicts';
import { cn } from '@/lib/utils';

/**
 * Who can reach each published port. Services stay private by default: the core binds their
 * ports to 127.0.0.1 with an override file, and public access goes through Websites (nginx),
 * where the server's firewall applies.
 */

/** A hairline above each table row, drawn on the cells since rows take no shadow. */
const CELL_HAIRLINE = '[&>td]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]';

function hostPort(binding: Pick<ComposePortBinding, 'hostIp' | 'published'>): string {
  const host = binding.hostIp ?? '*';
  return `${host.includes(':') ? `[${host}]` : host}:${binding.published ?? 'any'}`;
}

function holders(conflict: PortConflict): string {
  const names = conflict.holders.map(describeHolder);
  return names.length <= 2 ? names.join(' and ') : `${names[0]} and ${names.length - 1} more`;
}

/** Ports another container on the server already holds, listed before any detail. */
export function PortConflicts({
  conflicts,
}: {
  conflicts: readonly PortConflict[];
}): React.JSX.Element {
  return (
    <div
      role="alert"
      aria-label="Ports already in use"
      className="space-y-1.5 rounded-xl bg-warning/[0.06] px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-warning/35"
    >
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        {conflicts.length === 1
          ? 'A port this app publishes is already in use on the server.'
          : `${conflicts.length} ports this app publishes are already in use on the server.`}
      </p>
      <ul className="space-y-0.5 pl-5.5">
        {conflicts.map((conflict) => (
          <li key={`${conflict.service}-${conflict.index}-${conflict.target}`}>
            <span className="font-mono">
              {conflict.port}/{conflict.protocol}
            </span>{' '}
            for <span className="font-mono">{conflict.service}</span> is held by {holders(conflict)}
            .
          </li>
        ))}
      </ul>
      <p className="pl-5.5 text-muted-foreground">
        Docker will refuse to start a service on a port that is taken, so the deploy would fail.
        Change the host port in the compose file, or stop or remove the other container, before you
        deploy.
      </p>
    </div>
  );
}

export function ExposeStep({
  preview,
  proxied,
  updating,
  conflicts = [],
  onToggle,
}: {
  preview: DeployStackPreview;
  proxied: readonly string[];
  updating: boolean;
  /** Ports other containers on the server already hold. */
  conflicts?: readonly PortConflict[];
  onToggle: (service: string, keepPrivate: boolean) => void;
}): React.JSX.Element {
  const [showOverride, setShowOverride] = useState(false);
  const publishing = preview.services.filter((service) => service.publishes);

  return (
    <div className="space-y-5">
      <p className="flex items-start gap-2 rounded-xl bg-primary/[0.06] px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-primary/25">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          Private ports are bound to 127.0.0.1, so only this server reaches them. Public access
          comes through Websites, which puts a domain and TLS in front of a port. Published ports
          skip the server's firewall, so keep a port public only when nothing else will do.
        </span>
      </p>

      {conflicts.length > 0 && <PortConflicts conflicts={conflicts} />}

      {publishing.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No service publishes a port, so nothing outside the containers can reach this app.
        </p>
      ) : (
        <ul aria-label="Exposure" className="space-y-3">
          {publishing.map((service) => {
            const keepPrivate = proxied.includes(service.name);
            const after = preview.bindings.filter((binding) => binding.service === service.name);
            const label = `Keep ${service.name} private`;
            return (
              <li key={service.name} aria-label={service.name} className={cn(SECTION_WELL, 'p-3')}>
                <div className="flex flex-wrap items-center gap-3">
                  {keepPrivate ? (
                    <Lock className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <LockOpen className="h-3.5 w-3.5 text-warning" />
                  )}
                  <span className="min-w-0 flex-1 font-mono text-sm text-foreground">
                    {service.name}
                  </span>
                  <SimpleTooltip
                    label={
                      service.hostNetwork
                        ? 'It uses network_mode: host, so it listens on the server itself and cannot be kept on 127.0.0.1.'
                        : null
                    }
                    wrapTrigger
                  >
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      Keep private
                      <Switch
                        aria-label={label}
                        checked={keepPrivate}
                        disabled={service.hostNetwork || updating}
                        onCheckedChange={(checked) => onToggle(service.name, checked)}
                      />
                    </label>
                  </SimpleTooltip>
                </div>
                <table
                  aria-label={`Ports of ${service.name}`}
                  className="mt-2 w-full text-left text-xs"
                >
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 font-normal">Container</th>
                      <th className="py-1 font-normal">In the compose file</th>
                      <th className="py-1 font-normal">After deploy</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {service.ports.map((port) => {
                      const bound =
                        after.find(
                          (binding) =>
                            binding.index === port.index && binding.target === port.target,
                        ) ?? port;
                      const open = isPublicBinding(bound);
                      const taken = conflicts.find(
                        (conflict) =>
                          conflict.service === service.name &&
                          conflict.index === port.index &&
                          conflict.target === port.target,
                      );
                      return (
                        <tr
                          key={`${port.index}-${port.target}-${port.protocol}-${port.published}`}
                          className={CELL_HAIRLINE}
                        >
                          <td className="py-1 text-foreground">
                            {port.target}/{port.protocol}
                          </td>
                          <td className="py-1 text-muted-foreground">{hostPort(port)}</td>
                          <td className={cn('py-1', open ? 'text-warning' : 'text-success')}>
                            <span className="inline-flex items-center gap-1">
                              {open ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                              {hostPort(bound)}
                              <span className="font-sans text-muted-foreground">
                                ({bindingAddress(bound).toLowerCase()})
                              </span>
                            </span>
                            {taken && (
                              <span className="flex items-center gap-1 font-sans text-warning">
                                <TriangleAlert className="h-3 w-3" />
                                In use by {holders(taken)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </li>
            );
          })}
        </ul>
      )}

      {updating && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3 w-3 motion-safe:animate-spin" /> Working out the new bindings…
        </p>
      )}

      {preview.overrideText.trim() !== '' && (
        <div>
          <button
            type="button"
            aria-expanded={showOverride}
            onClick={() => setShowOverride((value) => !value)}
            className="flex cursor-pointer items-center gap-1.5 rounded-md text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showOverride ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            The override file the server writes
          </button>
          {showOverride && (
            <pre
              aria-label="Override file"
              className={cn(SECTION_WELL, 'mt-2 max-h-60 overflow-auto font-mono text-xs')}
            >
              {preview.overrideText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
