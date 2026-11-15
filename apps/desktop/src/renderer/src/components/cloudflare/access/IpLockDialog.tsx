import { addressInList, canonicalIp } from '@shared/cloudflare/ip';
import {
  type IpLockSpec,
  ipLockDescription,
  ipLockPreview,
  ipLockTarget,
  parseIpLock,
} from '@shared/cloudflare/ipLock';
import { buildRule, pathProblem } from '@shared/cloudflare/rules';
import type { CloudflareCustomRule, CloudflareZone } from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Monitor, NetworkIcon, Plus, Spinner } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { Field, SegmentedChoice } from '../fields';
import { AddressChips } from './AddressChips';

/** The name picker's value for "every name in the zone". */
const EVERY_NAME = '*';
const PROXIED_TYPES = new Set(['A', 'AAAA', 'CNAME']);

const SCOPES = [
  { value: 'all', label: 'Every page' },
  { value: 'path', label: 'One path' },
] as const;

const MATCHES = [
  { value: 'prefix', label: 'Path and below' },
  { value: 'exact', label: 'Only this path' },
] as const;

/** Names Cloudflare's proxy sits in front of; nothing else can be limited at Cloudflare. */
function proxiedNames(
  records: { type: string; name: string; proxied?: boolean }[] | undefined,
): string[] {
  const names = (records ?? [])
    .filter((record) => record.proxied && PROXIED_TYPES.has(record.type))
    .map((record) => record.name.toLowerCase())
    .filter((name) => !name.startsWith('*'));
  return [...new Set(names)].sort();
}

/**
 * Adds an IP limit to a zone, or changes one (E97): which name (or every name), the whole name or
 * one path, and the addresses that get in. A sentence says it back as it is filled in, and a
 * warning says when this computer would get the block page too, with a button to add it.
 */
export function IpLockDialog({
  zone,
  open,
  onOpenChange,
  existing,
}: {
  zone: CloudflareZone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing?: Pick<CloudflareCustomRule, 'id' | 'expression' | 'action'>;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const id = useId();
  const [start] = useState(() => (existing ? parseIpLock(existing) : null));
  const [name, setName] = useState(start ? (start.hostname ?? EVERY_NAME) : '');
  const [scope, setScope] = useState<'all' | 'path'>(start?.path ? 'path' : 'all');
  const [path, setPath] = useState(start?.path ?? '');
  const [match, setMatch] = useState<'exact' | 'prefix'>(start?.match ?? 'prefix');
  const [ips, setIps] = useState<string[]>(start?.ips ?? []);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const records = useQuery({
    queryKey: queryKeys.cloudflareRecords(zone.id),
    queryFn: () => window.runova.cloudflare.listRecords(zone.id),
  });
  const here = useQuery({
    queryKey: queryKeys.ipGeo,
    queryFn: () => window.runova.ipGeo.lookup(false),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const thisComputer = here.data?.ip ? canonicalIp(here.data.ip) : null;

  const names = proxiedNames(records.data);
  if (start?.hostname && !names.includes(start.hostname)) names.unshift(start.hostname);
  const options = [
    { value: EVERY_NAME, label: `Every name in ${zone.name}` },
    ...names.map((one) => ({ value: one, label: one })),
  ];

  const spec: IpLockSpec = {
    kind: 'ip-lock',
    hostname: name === EVERY_NAME ? null : name,
    path: scope === 'path' ? path.trim() : null,
    match: scope === 'path' ? match : 'prefix',
    ips,
  };
  const pathText = scope === 'path' && path.trim() !== '' ? pathProblem(path.trim()) : null;
  const built = buildRule(spec);
  const ready = name !== '' && built.ok && !saving;
  const target = ipLockTarget(spec, zone.name);
  const shutOut = thisComputer !== null && ips.length > 0 && !addressInList(thisComputer, ips);
  const canAddHere = thisComputer !== null && !addressInList(thisComputer, ips);

  async function save(): Promise<void> {
    setSaving(true);
    setProblem(null);
    const input = { description: ipLockDescription(spec), spec };
    try {
      const rules = existing
        ? await window.runova.cloudflare.updateCustomRule(zone.id, existing.id, input)
        : await window.runova.cloudflare.createCustomRule(zone.id, input);
      queryClient.setQueryData(queryKeys.cloudflareCustomRules(zone.id), rules);
      toast.success(
        existing
          ? `Saved the IP limit for ${target}.`
          : `Only the listed addresses can open ${target} now.`,
      );
      onOpenChange(false);
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="flex max-w-lg flex-col">
        <form
          className="-m-1 flex min-h-0 flex-col gap-4 overflow-y-auto p-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? 'Change the IP limit' : 'Limit by IP address'}</DialogTitle>
            <DialogDescription>
              Only the addresses you list can open it. Everyone else gets Cloudflare's block page,
              before anything reaches your server.
            </DialogDescription>
          </DialogHeader>

          <Field
            label="Name"
            htmlFor={`${id}-name`}
            hint="Only names behind Cloudflare's proxy are listed. The others go straight to your server, where Cloudflare cannot stop anyone."
          >
            <Combobox
              id={`${id}-name`}
              options={options}
              value={name}
              placeholder={records.isPending ? 'Loading names...' : 'Pick a name'}
              searchPlaceholder="Search names"
              emptyText="No name matches"
              disabled={saving}
              onChange={(next) => {
                setName(next);
                setProblem(null);
              }}
            />
          </Field>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span id={`${id}-scope`} className="text-sm font-medium text-foreground">
                Covers
              </span>
              <SegmentedChoice
                labelledBy={`${id}-scope`}
                layoutId={`ip-lock-scope-${id}`}
                options={SCOPES}
                value={scope}
                disabled={saving}
                onChange={setScope}
              />
            </div>
            {scope === 'all' ? (
              <p className="text-xs text-muted-foreground">
                Let's Encrypt's certificate checks still get through, so renewals keep working.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-path`}>Path</Label>
                  <Input
                    id={`${id}-path`}
                    value={path}
                    placeholder="/admin"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={pathText ? true : undefined}
                    className="font-mono"
                    disabled={saving}
                    onChange={(event) => setPath(event.target.value)}
                  />
                  {pathText && <p className="text-xs text-destructive">{pathText}</p>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span id={`${id}-match`} className="text-xs text-muted-foreground">
                    Match
                  </span>
                  <SegmentedChoice
                    labelledBy={`${id}-match`}
                    layoutId={`ip-lock-match-${id}`}
                    options={MATCHES}
                    value={match}
                    disabled={saving}
                    onChange={setMatch}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={`${id}-ips`}>Addresses that get in</Label>
              {canAddHere && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  aria-label={`Add this computer, ${thisComputer}`}
                  disabled={saving}
                  onClick={() => setIps([...ips, thisComputer])}
                >
                  <Plus className="h-3 w-3" /> This computer
                  <span className="font-mono text-muted-foreground">{thisComputer}</span>
                </Button>
              )}
            </div>
            <AddressChips
              id={`${id}-ips`}
              value={ips}
              onChange={(next) => {
                setIps(next);
                setProblem(null);
              }}
              describedBy={`${id}-ips-hint`}
            />
            <p id={`${id}-ips-hint`} className="text-xs text-muted-foreground">
              Press Enter after each one. A range like 198.51.100.0/24 covers a whole office or VPN.
            </p>
          </div>

          <Notice
            tone={name !== '' && ips.length > 0 ? 'primary' : 'neutral'}
            icon={NetworkIcon}
            size="sm"
            aria-live="polite"
          >
            {name === ''
              ? 'Pick a name, then add the addresses that get in.'
              : ipLockPreview(spec, zone.name)}
          </Notice>

          {shutOut && (
            <Notice tone="warning" icon={Monitor} size="sm">
              This computer ({thisComputer}) is not on the list, so it gets the block page too.
            </Notice>
          )}

          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              {saving && <Spinner className="h-3.5 w-3.5" />}
              {existing ? 'Save' : 'Add limit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
