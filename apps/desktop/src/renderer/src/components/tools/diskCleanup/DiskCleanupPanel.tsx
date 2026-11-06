import {
  type CacheProviderId,
  type CleanResult,
  type CleanSelection,
  type ProviderScan,
  planKeepNewest,
} from '@runova/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CircleInfo, HardDrive, Lock, Trash2 } from '@/components/icons';
import {
  CARD_GRID,
  EmptyState,
  NoMatches,
  PillTabs,
  SearchPill,
  TOOLBAR,
} from '@/components/pageKit';
import { CacheCard } from '@/components/systemCleanup/CacheCard';
import { CleanupHero, type HeroPhase } from '@/components/systemCleanup/CleanupHero';
import { ResultNotice } from '@/components/systemCleanup/ResultNotice';
import { ReviewView } from '@/components/systemCleanup/ReviewView';
import { formatBytes } from '@/lib/format';
import {
  allOldVersionsConfirm,
  type ConfirmContent,
  commandConfirm,
  everythingConfirm,
  itemsConfirm,
  oldVersionsConfirm,
} from '@/lib/systemCleanup/confirm';
import {
  type CardSort,
  type CardTab,
  cardModels,
  filterCards,
  overview,
  sortCards,
} from '@/lib/systemCleanup/view';
import { confirmDialog } from '@/stores/confirmStore';
import { useSystemCleanupStore } from '@/stores/systemCleanupStore';

/**
 * The Disk Cleanup tab of Dev Tools: the caches package managers and developer tools keep, what
 * each takes, and removing old versions or everything.
 *
 * It never scans on its own; reading a large cache takes a minute or more. Until the person
 * asks, it shows what was remembered from the last scan, and a remembered cache is read again
 * (just that cache) before anything is done to it, so a clean-up is always built from a fresh
 * look. What may be removed is decided in the main process and checked again there before each
 * removal. This tab only picks from what a scan reported, and asks first.
 */

const SORTS: { value: CardSort; label: string }[] = [
  { value: 'size', label: 'Size' },
  { value: 'reclaimable', label: 'Can free' },
  { value: 'name', label: 'Name' },
];

function askFor(content: ConfirmContent): Promise<boolean> {
  return confirmDialog({
    title: content.title,
    description: content.description,
    items: content.items,
    moreCount: content.moreCount,
    warning: content.warning,
    confirmLabel: content.confirmLabel,
    icon: Trash2,
    variant: 'destructive',
  });
}

function liveProvider(id: CacheProviderId): ProviderScan | null {
  const scan = useSystemCleanupStore.getState().scan;
  return scan?.providers.find((one) => one.id === id && one.status === 'ready') ?? null;
}

/** Makes sure a cache was read in this session, reading just that one if it was not. */
async function ensureLive(id: CacheProviderId): Promise<ProviderScan | null> {
  if (!liveProvider(id)) await useSystemCleanupStore.getState().startScan([id]);
  return liveProvider(id);
}

export function DiskCleanupPanel(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const openId = params.get('cache') as CacheProviderId | null;

  /** Opens one cache's review, or goes back to the list. Leaves the page's `?tab=` alone. */
  const setOpenCache = useCallback(
    (id: CacheProviderId | null, options?: { replace?: boolean }) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (id) next.set('cache', id);
        else next.delete('cache');
        return next;
      }, options);
    },
    [setParams],
  );

  const availability = useSystemCleanupStore((state) => state.availability);
  const scan = useSystemCleanupStore((state) => state.scan);
  const progress = useSystemCleanupStore((state) => state.progress);
  const cleaning = useSystemCleanupStore((state) => state.cleaning);
  const summaries = useSystemCleanupStore((state) => state.summaries);
  const keep = useSystemCleanupStore((state) => state.keep);
  const statuses = useSystemCleanupStore((state) => state.itemStatuses);
  const error = useSystemCleanupStore((state) => state.error);
  const { checkAvailability, startScan, startClean, cancel, setKeep, dismissResult } =
    useSystemCleanupStore.getState();

  const [tab, setTab] = useState<CardTab>('all');
  const [sort, setSort] = useState<CardSort>('size');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CleanResult[]>([]);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  const { cards, absent } = useMemo(
    () => cardModels({ scan, progress, summaries, keep }),
    [scan, progress, summaries, keep],
  );
  const visible = useMemo(
    () => sortCards(filterCards(cards, { tab, query }), sort),
    [cards, tab, query, sort],
  );
  const over = useMemo(() => overview(cards, scan?.volumes ?? []), [cards, scan]);
  const biggest = Math.max(1, ...cards.map((card) => card.bytes));
  const busy = progress.running || cleaning.running;

  const openProvider = openId ? liveProvider(openId) : null;
  // A review that no longer has a scan behind it (the app was reloaded) goes back to the list.
  useEffect(() => {
    if (openId && !openProvider && !busy) setOpenCache(null, { replace: true });
  }, [openId, openProvider, busy, setOpenCache]);

  const phase: HeroPhase = progress.running
    ? 'scanning'
    : cleaning.running
      ? 'cleaning'
      : cards.length === 0 && !scan
        ? 'empty'
        : 'ready';

  const scanInfo = useMemo(() => {
    const entries = progress.order.map((id) => progress.providers[id]);
    return {
      done: entries.filter((one) => one && one.status !== 'queued' && one.status !== 'scanning')
        .length,
      total: progress.order.length,
      bytes: entries.reduce((sum, one) => sum + (one?.bytes ?? 0), 0),
      files: entries.reduce((sum, one) => sum + (one?.files ?? 0), 0),
    };
  }, [progress]);

  const cleanLabel = cleaning.providerId
    ? (scan?.providers.find((one) => one.id === cleaning.providerId)?.label ?? null)
    : null;

  async function runCleans(selections: CleanSelection[]): Promise<void> {
    const done: CleanResult[] = [];
    setResults([]);
    for (const selection of selections) {
      const result = await startClean(selection);
      if (!result) break;
      done.push(result);
      if (result.cancelled) break;
    }
    setResults(done);
    const freed = done.reduce((sum, one) => sum + one.freedBytes, 0);
    if (done.some((one) => one.failed.length > 0)) {
      toast.warning(`Freed ${formatBytes(freed)}. Some things could not be removed.`);
    } else if (freed > 0) {
      toast.success(`Freed ${formatBytes(freed)}.`);
    }
  }

  async function cleanOld(id: CacheProviderId): Promise<void> {
    const provider = await ensureLive(id);
    if (!provider) return;
    const content = oldVersionsConfirm(provider, keep);
    if (!content) {
      toast.info(`Nothing old to remove in ${provider.label}.`);
      return;
    }
    if (!(await askFor(content))) return;
    await runCleans([{ mode: 'old-versions', providerId: id, keep }]);
  }

  async function cleanAllOld(): Promise<void> {
    const wanted = cards.filter((card) => card.actions.cleanOld).map((card) => card.id);
    const unread = wanted.filter((id) => !liveProvider(id));
    if (unread.length > 0) await startScan(unread);
    const providers = wanted
      .map(liveProvider)
      .filter((one): one is ProviderScan => one !== null)
      .filter((one) => planKeepNewest(one.items, { keep }).remove.length > 0);
    const content = allOldVersionsConfirm(providers, keep);
    if (!content) {
      toast.info('Nothing old to remove.');
      return;
    }
    if (!(await askFor(content))) return;
    await runCleans(
      providers.map((one) => ({ mode: 'old-versions', providerId: one.id, keep }) as const),
    );
  }

  async function clearAll(id: CacheProviderId): Promise<void> {
    const provider = await ensureLive(id);
    if (!provider || !(await askFor(everythingConfirm(provider)))) return;
    await runCleans([{ mode: 'everything', providerId: id }]);
  }

  async function runTool(id: CacheProviderId, kind: 'tidy' | 'clear-command'): Promise<void> {
    const provider = await ensureLive(id);
    const label = kind === 'tidy' ? provider?.tidyCommand?.label : provider?.clearCommand?.label;
    if (!provider || !label) return;
    if (!(await askFor(commandConfirm(provider, { kind, label })))) return;
    await runCleans([{ mode: kind, providerId: id }]);
  }

  async function review(id: CacheProviderId): Promise<void> {
    if (await ensureLive(id)) setOpenCache(id);
  }

  async function deletePicked(provider: ProviderScan, picked: ReadonlySet<string>): Promise<void> {
    const content = itemsConfirm(provider, picked);
    if (!content || !(await askFor(content))) return;
    await runCleans([{ mode: 'items', providerId: provider.id, itemIds: [...picked] }]);
  }

  function reveal(id: CacheProviderId): void {
    Promise.resolve(window.runova.systemCleanup.reveal(id)).catch(() => undefined);
  }

  if (availability === null) {
    return <div className="flex flex-col gap-3" aria-busy="true" />;
  }
  if (!availability.enabled) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          card
          icon={HardDrive}
          title="Disk Cleanup is switched off"
          description={availability.reason}
        />
      </div>
    );
  }

  const notice = (
    <ResultNotice
      results={results}
      error={error}
      onDismiss={() => {
        setResults([]);
        dismissResult();
      }}
      onScan={() => void startScan()}
    />
  );

  if (openProvider) {
    return (
      <div className="flex flex-col gap-3">
        {notice}
        <ReviewView
          provider={openProvider}
          keep={keep}
          statuses={statuses}
          busy={busy}
          cleaning={
            cleaning.running && cleaning.providerId === openProvider.id
              ? { processed: cleaning.processed, total: cleaning.total }
              : null
          }
          onKeepChange={setKeep}
          onBack={() => setOpenCache(null)}
          onReveal={() => reveal(openProvider.id)}
          onDelete={(picked) => void deletePicked(openProvider, picked)}
          onRetry={(itemId) =>
            void runCleans([{ mode: 'items', providerId: openProvider.id, itemIds: [itemId] }])
          }
        />
      </div>
    );
  }

  const freeCount = cards.filter((card) => card.reclaimableBytes > 0).length;
  const toolCount = cards.filter((card) => card.kind === 'opaque').length;

  return (
    <div className="flex flex-col gap-3">
      <CleanupHero
        phase={phase}
        overview={over}
        keep={keep}
        scan={phase === 'scanning' ? scanInfo : null}
        clean={
          phase === 'cleaning'
            ? {
                label: cleanLabel,
                processed: cleaning.processed,
                total: cleaning.total,
                freedBytes: cleaning.freedBytes,
              }
            : null
        }
        onKeepChange={setKeep}
        onScan={() => void startScan()}
        onCancel={cancel}
        onCleanOld={() => void cleanAllOld()}
      />

      {notice}

      {cards.length > 0 && (
        <div className={TOOLBAR}>
          <SearchPill
            className="w-full sm:w-64"
            label="Search caches"
            type="search"
            placeholder="Search caches"
            clearLabel="Clear search"
            value={query}
            onValueChange={setQuery}
          />
          <PillTabs
            id="cleanup-tab"
            label="Show"
            items={[
              { value: 'all' as const, label: 'All', count: cards.length },
              { value: 'free' as const, label: 'Can free space', count: freeCount },
              { value: 'tool' as const, label: 'Cleaned by a tool', count: toolCount },
            ]}
            value={tab}
            onChange={setTab}
          />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Sort by</span>
            <PillTabs
              id="cleanup-sort"
              label="Sort by"
              kind="toggle"
              size="xs"
              items={SORTS}
              value={sort}
              onChange={setSort}
            />
          </div>
        </div>
      )}

      {cards.length > 0 &&
        (visible.length === 0 ? (
          <NoMatches query={query || 'these filters'} />
        ) : (
          <div className="@container/grid">
            <div className={CARD_GRID}>
              {visible.map((card) => (
                <CacheCard
                  key={card.id}
                  card={card}
                  biggest={biggest}
                  busy={busy}
                  onReview={() => void review(card.id)}
                  onCleanOld={() => void cleanOld(card.id)}
                  onClearAll={() => void clearAll(card.id)}
                  onTool={(kind) => void runTool(card.id, kind)}
                  onScan={() => void startScan([card.id])}
                  onReveal={() => reveal(card.id)}
                />
              ))}
            </div>
          </div>
        ))}

      {absent.length > 0 && !progress.running && (
        <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
          <CircleInfo className="mt-px h-3 w-3 shrink-0" />
          <span>Not on this machine: {absent.join(', ')}.</span>
        </p>
      )}

      <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
        <Lock className="mt-px h-3 w-3 shrink-0" />
        <span>
          Disk Cleanup only removes caches that tools download again. Your source, your projects and
          your settings are never touched. What it removes is deleted for good, and each removal is
          written to a log in the app's data folder.
        </span>
      </p>
    </div>
  );
}
