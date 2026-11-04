import type { ServiceLimits } from '@runova/core';
import { useState } from 'react';
import { Rocket, Spinner } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { LimitsHostFacts } from '@/lib/deploy/limits/editor';
import { ResourceLimitsEditor } from '../limits/ResourceLimitsEditor';

/**
 * The step between the install sheet and the install: how much of the server each container the
 * app makes may use. Everything starts Unlimited, so Install right away changes nothing.
 */

export interface InstallLimitsDialogProps {
  open: boolean;
  /** The containers the install makes, by service name. */
  services: readonly string[];
  /** The server's size; null while it loads, or when the core cannot apply caps. */
  host: LimitsHostFacts | null;
  /** The core answered without its size: it is too old to apply caps. */
  outdated?: boolean;
  /** What the app needs to run well, from its template. */
  minMemoryMb?: number;
  busy: boolean;
  onBack: () => void;
  onInstall: (limits: ServiceLimits[]) => void;
}

export function InstallLimitsDialog({
  open,
  services,
  host,
  outdated = false,
  minMemoryMb,
  busy,
  onBack,
  onInstall,
}: InstallLimitsDialogProps): React.JSX.Element {
  const [limits, setLimits] = useState<ServiceLimits[]>([]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onBack()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Set resource limits</DialogTitle>
          <DialogDescription>
            Choose how much of the server each container may use. You can change these later from
            the app's page.
          </DialogDescription>
        </DialogHeader>
        {host ? (
          <ResourceLimitsEditor
            services={services}
            value={limits}
            onChange={setLimits}
            host={host}
            minMemoryMb={minMemoryMb}
          />
        ) : (
          <Notice tone={outdated ? 'warning' : 'neutral'}>
            {outdated
              ? "Update this server's core to set resource limits. The app installs without limits."
              : "Reading the server's size. You can install now without limits, or wait a moment."}
          </Notice>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
            Back
          </Button>
          <Button type="button" disabled={busy} onClick={() => onInstall(host ? limits : [])}>
            {busy ? <Spinner className="motion-safe:animate-spin" /> : <Rocket />}
            {busy ? 'Installing' : 'Install'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
