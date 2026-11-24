import {
  checkPurgeHosts,
  checkPurgePrefixes,
  checkPurgeUrls,
  PURGE_URL_LIMIT,
} from '@shared/cloudflare/zone';
import type { CloudflarePurgeRequest, CloudflareZone } from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useReducedMotion } from 'framer-motion';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bolt, Spinner, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { CardBody, CloudflareCard, SegmentedChoice } from './fields';
import { PurgeEverythingDialog } from './PurgeEverythingDialog';

type PurgeKind = 'urls' | 'prefixes' | 'hosts';

const KINDS: readonly { value: PurgeKind; label: string }[] = [
  { value: 'urls', label: 'URLs' },
  { value: 'prefixes', label: 'Folders' },
  { value: 'hosts', label: 'Hostnames' },
];

type Checked =
  | { ok: true; request: CloudflarePurgeRequest; count: number }
  | { ok: false; problem: string };

/** What each kind of list says, and how it is checked against the domain before it goes out. */
const KIND_TEXT: Record<
  PurgeKind,
  {
    field: string;
    one: string;
    many: string;
    placeholder: (zone: string) => string;
    help: string;
    check: (text: string, zone: string) => Checked;
  }
> = {
  urls: {
    field: 'URLs to purge',
    one: 'URL',
    many: 'URLs',
    placeholder: (zone) => `https://${zone}/styles.css`,
    help: `One full URL per line, up to ${PURGE_URL_LIMIT} at a time.`,
    check: (text, zone) => {
      const checked = checkPurgeUrls(text, zone);
      return checked.ok
        ? { ok: true, request: { urls: checked.urls }, count: checked.urls.length }
        : checked;
    },
  },
  prefixes: {
    field: 'Folders to purge',
    one: 'folder',
    many: 'folders',
    placeholder: (zone) => `${zone}/blog/`,
    help: `One folder per line, up to ${PURGE_URL_LIMIT} at a time. Everything under it goes, so a blog folder takes every blog page with it.`,
    check: (text, zone) => {
      const checked = checkPurgePrefixes(text, zone);
      return checked.ok
        ? { ok: true, request: { prefixes: checked.items }, count: checked.items.length }
        : checked;
    },
  },
  hosts: {
    field: 'Hostnames to purge',
    one: 'hostname',
    many: 'hostnames',
    placeholder: (zone) => `www.${zone}`,
    help: `One hostname per line, up to ${PURGE_URL_LIMIT} at a time. Everything cached for that name goes, which suits a single subdomain.`,
    check: (text, zone) => {
      const checked = checkPurgeHosts(text, zone);
      return checked.ok
        ? { ok: true, request: { hosts: checked.items }, count: checked.items.length }
        : checked;
    },
  },
};

const NO_DRAFTS: Record<PurgeKind, string> = { urls: '', prefixes: '', hosts: '' };

/**
 * Cache purges (T3): the listed URLs, folders or hostnames straight away, or everything after
 * typing the domain's name, since a full purge sends every next request to the server. Each kind
 * keeps its own draft, so trying another one never loses what was typed. `focusRequest` moves
 * focus to the list each time it goes up, for the zone header's purge menu.
 */
export function PurgeCard({
  zone,
  focusRequest = 0,
}: {
  zone: CloudflareZone;
  focusRequest?: number;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();
  const fieldId = useId();
  const kindLabelId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [kind, setKind] = useState<PurgeKind>('urls');
  const [drafts, setDrafts] = useState(NO_DRAFTS);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const text = KIND_TEXT[kind];
  const draft = drafts[kind];

  useEffect(() => {
    if (focusRequest <= 0) return;
    const field = fieldRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    // The whole card comes into view, not just the box, so the URLs, Folders and Hostnames choice
    // above it is not left cut off at the edge. A frame later, once the tab it just opened on has
    // laid out.
    const frame = requestAnimationFrame(() => {
      (field.closest('section') ?? field).scrollIntoView?.({
        block: 'nearest',
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, reduceMotion]);

  async function purgeList(): Promise<void> {
    const checked = text.check(draft, zone.name);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    const purgedKind = kind;
    setBusy(true);
    setProblem(null);
    try {
      await window.runova.cloudflare.purgeCache(zone.id, checked.request);
      const { one, many } = KIND_TEXT[purgedKind];
      toast.success(`Purged ${checked.count} ${checked.count === 1 ? one : many} from the cache.`);
      setDrafts((current) => ({ ...current, [purgedKind]: '' }));
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CloudflareCard
      icon={<Bolt />}
      title="Purge cache"
      description="Cloudflare keeps copies of your files close to visitors. Purge them when a change does not show up."
    >
      <CardBody className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={fieldId}>{text.field}</Label>
            <span id={kindLabelId} className="sr-only">
              What to purge
            </span>
            <SegmentedChoice
              labelledBy={kindLabelId}
              layoutId={`purge-kind-${zone.id}`}
              options={KINDS}
              value={kind}
              disabled={busy}
              onChange={(next) => {
                setKind(next);
                setProblem(null);
              }}
            />
          </div>
          <Textarea
            ref={fieldRef}
            id={fieldId}
            value={draft}
            rows={3}
            spellCheck={false}
            placeholder={text.placeholder(zone.name)}
            className="font-mono text-xs"
            onChange={(event) => {
              const value = event.target.value;
              setDrafts((current) => ({ ...current, [kind]: value }));
              setProblem(null);
            }}
          />
          <p className="text-xs text-muted-foreground">{text.help}</p>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={busy || draft.trim() === ''} onClick={() => void purgeList()}>
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Purge these{' '}
            {text.many}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            <Trash2 className="h-3.5 w-3.5" /> Purge everything
          </Button>
        </div>
      </CardBody>
      <PurgeEverythingDialog zone={zone} open={confirming} onOpenChange={setConfirming} />
    </CloudflareCard>
  );
}
