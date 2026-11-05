import type {
  CleanResult,
  CleanSelection,
  ProviderScan,
  ScanItem,
  SystemCleanupScan,
} from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { useSystemCleanupStore } from '@/stores/systemCleanupStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';
import DiskCleanupPage from './DiskCleanupPage';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const MB = 1024 ** 2;
const GB = 1024 ** 3;

let counter = 0;
function item(group: string, version: string, bytes: number): ScanItem {
  counter += 1;
  return {
    id: `i${counter}`,
    group,
    groupLabel: group,
    version,
    bytes,
    sharedBytes: 0,
    files: 4,
    newestMs: Date.now() - 86_400_000,
  };
}

function provider(
  id: ProviderScan['id'],
  label: string,
  over: Partial<ProviderScan> = {},
): ProviderScan {
  return {
    id,
    label,
    tagline: `${label} things`,
    kind: 'versioned',
    status: 'ready',
    root: `/caches/${id}`,
    bytes: 0,
    files: 0,
    sharedBytes: 0,
    unreadable: 0,
    items: [],
    clearCommand: null,
    tidyCommand: null,
    afterClearing: `${label} downloads it again.`,
    ...over,
  };
}

const nugetItems = [
  item('acornima', '1.0.0', 100 * MB),
  item('acornima', '2.0.0', 200 * MB),
  item('acornima', '3.0.0', 400 * MB),
];
const bunItems = [item('react', '19.2.8', 50 * MB), item('react', '19.3.1', 60 * MB)];

function scanData(): SystemCleanupScan {
  return {
    scanId: 'scan-1',
    startedAt: 1,
    finishedAt: Date.now(),
    cancelled: false,
    providers: [
      provider('nuget', 'NuGet', { bytes: 700 * MB, files: 12, items: nugetItems }),
      provider('bun', 'Bun', { bytes: 110 * MB, files: 8, items: bunItems }),
      provider('npm', 'npm', {
        kind: 'opaque',
        bytes: 300 * MB,
        files: 90,
        clearCommand: { label: 'npm cache clean --force' },
      }),
      provider('cargo', 'Cargo', { status: 'missing', root: null }),
    ],
    volumes: [{ mount: 'C:', totalBytes: 453 * GB, freeBytes: 31 * GB, cacheBytes: GB }],
  };
}

function cleanResult(providerId: ProviderScan['id'], over: Partial<CleanResult> = {}): CleanResult {
  const base = scanData().providers.find((p) => p.id === providerId) as ProviderScan;
  return {
    providerId,
    removed: 2,
    freedBytes: 300 * MB,
    failed: [],
    skipped: [],
    cancelled: false,
    provider: base,
    ...over,
  };
}

function page(bridge: Record<string, unknown> = {}, route = '/') {
  return renderWithProviders(
    <>
      <DiskCleanupPage />
      <ConfirmDialogHost />
    </>,
    {
      route,
      bridge: {
        'systemCleanup.status': async () => ({ enabled: true }),
        'systemCleanup.scan': async () => scanData(),
        'systemCleanup.cancel': async () => true,
        'systemCleanup.reveal': async () => true,
        ...bridge,
      },
    },
  );
}

async function scanned(bridge: Record<string, unknown> = {}) {
  const view = page(bridge);
  await view.user.click(await screen.findByRole('button', { name: /find caches/i }));
  await screen.findByRole('region', { name: /nuget cache/i });
  return view;
}

const card = (name: string) =>
  screen.getByRole('region', { name: new RegExp(`${name} cache`, 'i') });

beforeEach(() => {
  vi.clearAllMocks();
  useSystemCleanupStore.setState({ summaries: {}, keep: 1 });
});

function remembered(id: 'nuget' | 'bun', over: Record<string, unknown> = {}) {
  return {
    id,
    label: id === 'nuget' ? 'NuGet' : 'Bun',
    tagline: `${id} things`,
    kind: 'versioned' as const,
    bytes: 700 * MB,
    files: 12,
    packageCount: 1,
    reclaimableBytes: 300 * MB,
    root: `/caches/${id}`,
    scannedAt: Date.now() - 86_400_000,
    clearLabel: null,
    tidyLabel: null,
    ...over,
  };
}

describe('DiskCleanupPage, when it is off', () => {
  it('says why and offers nothing to scan', async () => {
    page({ 'systemCleanup.status': async () => ({ enabled: false, reason: 'Off in tests.' }) });
    expect(await screen.findByText('Off in tests.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /find caches/i })).not.toBeInTheDocument();
  });
});

describe('DiskCleanupPage, the first scan', () => {
  it('invites the first scan and does not start one by itself', async () => {
    const view = page();
    expect(await screen.findByText(/see what your tools are keeping/i)).toBeInTheDocument();
    expect(() => view.bridge.$fn('systemCleanup.scan')).toThrow(/has not been touched/);
  });

  it('scans, then shows a card for each cache and what could be freed', async () => {
    await scanned();
    expect(card('NuGet')).toBeInTheDocument();
    expect(card('Bun')).toBeInTheDocument();
    expect(card('npm')).toBeInTheDocument();
    expect(screen.getByText(/can be freed/i)).toBeInTheDocument();
    // 300 MB from NuGet plus 50 MB from Bun.
    expect(screen.getByText('350 MB')).toBeInTheDocument();
  });

  it('lists the caches that are not on this machine, by name', async () => {
    await scanned();
    expect(screen.getByText(/not on this machine/i)).toHaveTextContent('Cargo');
  });

  it('puts the biggest cache first', async () => {
    await scanned();
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(['NuGet', 'npm', 'Bun']);
  });

  it('can stop a scan under way', async () => {
    let release: (scan: SystemCleanupScan) => void = () => undefined;
    const held = new Promise<SystemCleanupScan>((resolve) => {
      release = resolve;
    });
    const view = page({ 'systemCleanup.scan': () => held });
    try {
      await view.user.click(await screen.findByRole('button', { name: /find caches/i }));
      await view.user.click(await screen.findByRole('button', { name: /stop/i }));
      expect(view.bridge.$fn('systemCleanup.cancel')).toHaveBeenCalledTimes(1);
    } finally {
      release(scanData());
    }
  });

  it('says in words when a scan fails, and lets the person try again', async () => {
    const view = page({
      'systemCleanup.scan': async () => {
        throw new Error('Error invoking remote method: Error: Disk is on fire.');
      },
    });
    await view.user.click(await screen.findByRole('button', { name: /find caches/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/disk is on fire/i);
    expect(screen.getByRole('button', { name: /scan again/i })).toBeInTheDocument();
  });
});

describe('DiskCleanupPage, what is remembered', () => {
  it('shows the caches from the last scan at once, and says they are from an earlier scan', async () => {
    const live = scanData().providers[0] as ProviderScan;
    useSystemCleanupStore.setState({
      summaries: {
        nuget: {
          id: 'nuget',
          label: 'NuGet',
          tagline: 'NuGet things',
          kind: 'versioned',
          bytes: live.bytes,
          files: live.files,
          packageCount: 1,
          reclaimableBytes: 300 * MB,
          root: live.root,
          scannedAt: Date.now() - 2 * 86_400_000,
          clearLabel: null,
          tidyLabel: null,
        },
      },
    });
    const view = page();
    expect(await screen.findByRole('region', { name: /nuget cache/i })).toBeInTheDocument();
    expect(screen.getByText(/from your last scan, 2d ago/i)).toBeInTheDocument();
    expect(() => view.bridge.$fn('systemCleanup.scan')).toThrow(/has not been touched/);
  });

  it('reads a remembered cache again before it is cleaned, then asks', async () => {
    useSystemCleanupStore.setState({
      summaries: {
        nuget: {
          id: 'nuget',
          label: 'NuGet',
          tagline: 'NuGet things',
          kind: 'versioned',
          bytes: 700 * MB,
          files: 12,
          packageCount: 1,
          reclaimableBytes: 300 * MB,
          root: '/caches/nuget',
          scannedAt: Date.now() - 86_400_000,
          clearLabel: null,
          tidyLabel: null,
        },
      },
    });
    const view = page();
    await view.user.click(
      await screen.findByRole('button', { name: /clean old versions in nuget/i }),
    );
    expect(await screen.findByRole('dialog')).toHaveTextContent(/remove old versions from nuget/i);
    expect(view.bridge.$fn('systemCleanup.scan')).toHaveBeenCalledWith(expect.any(String), [
      'nuget',
    ]);
  });
});

describe('DiskCleanupPage, cleaning old versions', () => {
  it('asks first, and says what goes and what it frees', async () => {
    const view = await scanned();
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Remove old versions from NuGet?');
    expect(dialog).toHaveTextContent(/frees up to 300 MB/i);
    expect(dialog).toHaveTextContent(/deleted for good/i);
  });

  it('removes nothing if the person says no', async () => {
    const view = await scanned({ 'systemCleanup.clean': async () => cleanResult('nuget') });
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
    );
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }),
    );
    expect(() => view.bridge.$fn('systemCleanup.clean')).toThrow(/has not been touched/);
  });

  it('cleans from the scan it made, names the choice, and says what was freed', async () => {
    const view = await scanned({ 'systemCleanup.clean': async () => cleanResult('nuget') });
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
    );
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /free 300 mb/i }),
    );
    await waitFor(() => expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalled());
    expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalledWith(
      expect.any(String),
      'scan-1',
      {
        mode: 'old-versions',
        providerId: 'nuget',
        keep: 1,
      } satisfies CleanSelection,
    );
    expect(await screen.findByText(/freed 300 mb from nuget/i)).toBeInTheDocument();
  });

  it('keeps as many versions as the person chose', async () => {
    const view = await scanned({ 'systemCleanup.clean': async () => cleanResult('nuget') });
    await view.user.click(
      within(screen.getByRole('group', { name: /versions to keep/i })).getByRole('button', {
        name: '2',
      }),
    );
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
    );
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      /newest 2 versions of each package stay/i,
    );
  });

  it('cleans every cache that has something old with one question from the top', async () => {
    const view = await scanned({
      'systemCleanup.clean': async (_request: string, _scan: string, selection: CleanSelection) =>
        cleanResult(selection.providerId),
    });
    await view.user.click(
      screen.getAllByRole('button', { name: /^clean old versions$/i })[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Remove old versions from 2 caches?');
    await view.user.click(within(dialog).getByRole('button', { name: /free 350 mb/i }));
    await waitFor(() => expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalledTimes(2));
    const asked = view.bridge
      .$fn('systemCleanup.clean')
      .mock.calls.map((call) => (call[2] as CleanSelection).providerId)
      .sort();
    expect(asked).toEqual(['bun', 'nuget']);
    expect(await screen.findByText(/freed 600 mb from 2 caches/i)).toBeInTheDocument();
  });

  it('shows what could not be removed, and why', async () => {
    const view = await scanned({
      'systemCleanup.clean': async () =>
        cleanResult('nuget', {
          removed: 1,
          failed: [
            { itemId: 'a', label: 'acornima 1.0.0', reason: 'It is in use by another program.' },
          ],
        }),
    });
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
    );
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /free 300 mb/i }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 item could not be removed/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/in use by another program/i);
  });
});

describe('DiskCleanupPage, clearing everything', () => {
  it('asks with the folder in the question, then clears it all', async () => {
    const view = await scanned({ 'systemCleanup.clean': async () => cleanResult('bun') });
    await view.user.click(within(card('Bun')).getByRole('button', { name: /clear all of bun/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Clear all of Bun?');
    expect(dialog).toHaveTextContent('/caches/bun');
    await view.user.click(within(dialog).getByRole('button', { name: /clear 110 mb/i }));
    await waitFor(() => expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalled());
    expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalledWith(
      expect.any(String),
      'scan-1',
      {
        mode: 'everything',
        providerId: 'bun',
      },
    );
  });
});

describe('DiskCleanupPage, a cache only its tool cleans', () => {
  it("runs the tool's own command after asking", async () => {
    const view = await scanned({ 'systemCleanup.clean': async () => cleanResult('npm') });
    await view.user.click(
      within(card('npm')).getByRole('button', { name: /clear cache \(npm\)/i }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Clean npm with its own tool?');
    expect(dialog).toHaveTextContent('npm cache clean --force');
    await view.user.click(within(dialog).getByRole('button', { name: /run it/i }));
    await waitFor(() => expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalled());
    expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalledWith(
      expect.any(String),
      'scan-1',
      {
        mode: 'clear-command',
        providerId: 'npm',
      },
    );
  });
});

describe('DiskCleanupPage, the review', () => {
  async function review(bridge: Record<string, unknown> = {}) {
    const view = await scanned(bridge);
    await view.user.click(within(card('NuGet')).getByRole('button', { name: /review nuget/i }));
    await screen.findByRole('heading', { level: 2, name: 'NuGet' });
    return view;
  }

  it('opens one cache package by package, and goes back', async () => {
    const view = await review();
    expect(
      screen.getByRole('checkbox', { name: /select all versions of acornima/i }),
    ).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: /all caches/i }));
    expect(await screen.findByRole('region', { name: /bun cache/i })).toBeInTheDocument();
  });

  it('deletes the versions that are picked, after asking, by their ids', async () => {
    const view = await review({ 'systemCleanup.clean': async () => cleanResult('nuget') });
    await view.user.click(screen.getByRole('button', { name: /delete 300 mb/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete 2 items?');
    await view.user.click(within(dialog).getByRole('button', { name: /delete 300 mb/i }));
    await waitFor(() => expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalled());
    const selection = view.bridge.$fn('systemCleanup.clean').mock.calls[0]?.[2] as CleanSelection;
    expect(selection).toMatchObject({ mode: 'items', providerId: 'nuget' });
    expect(selection.mode === 'items' && [...selection.itemIds].sort()).toEqual(
      [nugetItems[0]?.id, nugetItems[1]?.id].sort(),
    );
  });
});

describe('DiskCleanupPage, finding and showing a cache', () => {
  it('searches caches by name', async () => {
    const view = await scanned();
    await view.user.type(screen.getByRole('searchbox', { name: /search caches/i }), 'bun');
    expect(screen.getByRole('region', { name: /bun cache/i })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /nuget cache/i })).not.toBeInTheDocument();
  });

  it('filters to the caches that have something to free', async () => {
    const view = await scanned();
    await view.user.click(screen.getByRole('button', { name: /can free space/i }));
    expect(screen.getByRole('region', { name: /nuget cache/i })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /npm cache/i })).not.toBeInTheDocument();
  });

  it('shows the folder of a cache in the file manager', async () => {
    const view = await scanned();
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /show nuget in its folder/i }),
    );
    expect(view.bridge.$fn('systemCleanup.reveal')).toHaveBeenCalledWith('nuget');
  });
});

/** A call that stays pending until the test lets it go, to watch the page while it works. */
function holdOpen<T>(key: string, value: () => T) {
  let release: (v: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { bridge: { [key]: () => promise }, release: () => release(value()) };
}

describe('DiskCleanupPage, while it works', () => {
  it('counts the caches read as the main process reports them', async () => {
    const scan = holdOpen('systemCleanup.scan', scanData);
    const view = page(scan.bridge);
    try {
      await view.user.click(await screen.findByRole('button', { name: /find caches/i }));
      const requestId = view.bridge.$fn('systemCleanup.scan').mock.calls[0]?.[0] as string;
      view.bridge.$emit('systemCleanup.onScanEvent', {
        type: 'started',
        requestId,
        scanId: 'scan-1',
        providers: [
          { id: 'nuget', label: 'NuGet' },
          { id: 'bun', label: 'Bun' },
        ],
      });
      view.bridge.$emit('systemCleanup.onScanEvent', {
        type: 'progress',
        requestId,
        providerId: 'nuget',
        bytes: 5 * GB,
        files: 900,
      });
      expect(await screen.findByRole('status')).toHaveTextContent(/0 of 2 caches read/i);
    } finally {
      scan.release();
    }
  });

  it('says what is being cleaned while a clean-up runs', async () => {
    const clean = holdOpen('systemCleanup.clean', () => cleanResult('nuget'));
    const view = await scanned(clean.bridge);
    try {
      await view.user.click(
        within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
      );
      await view.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: /free 300 mb/i }),
      );
      const requestId = (await waitFor(() => {
        const calls = view.bridge.$fn('systemCleanup.clean').mock.calls;
        expect(calls.length).toBe(1);
        return calls[0]?.[0];
      })) as string;
      view.bridge.$emit('systemCleanup.onCleanEvent', {
        type: 'started',
        requestId,
        providerId: 'nuget',
        total: 2,
        bytes: 300 * MB,
      });
      expect(await screen.findByText(/cleaning nuget/i)).toBeInTheDocument();
    } finally {
      clean.release();
    }
  });
});

function tidyScan(): SystemCleanupScan {
  const tidy = scanData();
  tidy.providers[0] = provider('nuget', 'NuGet', {
    bytes: 100 * MB,
    files: 3,
    items: [item('acornima', '1.0.0', 100 * MB)],
  });
  return tidy;
}

describe('DiskCleanupPage, when there is nothing to do', () => {
  it('says so, and asks nothing, if the fresh look finds nothing old after all', async () => {
    useSystemCleanupStore.setState({ summaries: { nuget: remembered('nuget') } });
    const view = page({ 'systemCleanup.scan': async () => tidyScan() });
    await view.user.click(
      await screen.findByRole('button', { name: /clean old versions in nuget/i }),
    );
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Nothing old to remove in NuGet.'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reads the remembered caches, then asks once for all of them from the top', async () => {
    useSystemCleanupStore.setState({
      summaries: {
        nuget: remembered('nuget'),
        bun: remembered('bun', { reclaimableBytes: 50 * MB }),
      },
    });
    const view = page();
    await view.user.click(await screen.findByRole('button', { name: /^clean old versions$/i }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Remove old versions from 2 caches?',
    );
    expect(view.bridge.$fn('systemCleanup.scan')).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['nuget', 'bun']),
    );
  });

  it('says so from the top when nothing old turns up after reading', async () => {
    useSystemCleanupStore.setState({ summaries: { nuget: remembered('nuget') } });
    const view = page({ 'systemCleanup.scan': async () => tidyScan() });
    await view.user.click(await screen.findByRole('button', { name: /^clean old versions$/i }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Nothing old to remove.'));
  });
});

describe('DiskCleanupPage, saying no and stopping', () => {
  it('removes nothing when Clear all is cancelled', async () => {
    const view = await scanned({ 'systemCleanup.clean': async () => cleanResult('bun') });
    await view.user.click(within(card('Bun')).getByRole('button', { name: /clear all of bun/i }));
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }),
    );
    expect(() => view.bridge.$fn('systemCleanup.clean')).toThrow(/has not been touched/);
  });

  it('removes nothing when a review is cancelled', async () => {
    const view = await scanned({ 'systemCleanup.clean': async () => cleanResult('nuget') });
    await view.user.click(within(card('NuGet')).getByRole('button', { name: /review nuget/i }));
    await view.user.click(await screen.findByRole('button', { name: /delete 300 mb/i }));
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }),
    );
    expect(() => view.bridge.$fn('systemCleanup.clean')).toThrow(/has not been touched/);
  });

  it('says when a clean-up was stopped part way', async () => {
    const view = await scanned({
      'systemCleanup.clean': async () =>
        cleanResult('nuget', { cancelled: true, freedBytes: 100 * MB }),
    });
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
    );
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /free 300 mb/i }),
    );
    expect(
      await screen.findByText(/stopped\. freed 100 mb before it stopped/i),
    ).toBeInTheDocument();
  });

  it('says in words when a clean-up fails, and offers to scan again', async () => {
    const view = await scanned({
      'systemCleanup.clean': async () => {
        throw new Error(
          "Error invoking remote method 'systemCleanup:clean': Error: That scan is out of date.",
        );
      },
    });
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
    );
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /free 300 mb/i }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/out of date/i);
    await view.user.click(within(alert).getByRole('button', { name: /scan again/i }));
    await waitFor(() => expect(view.bridge.$fn('systemCleanup.scan')).toHaveBeenCalledTimes(2));
  });

  it('puts the result away when dismissed', async () => {
    const view = await scanned({ 'systemCleanup.clean': async () => cleanResult('nuget') });
    await view.user.click(
      within(card('NuGet')).getByRole('button', { name: /clean old versions/i }),
    );
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /free 300 mb/i }),
    );
    await view.user.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(/freed 300 mb from nuget/i)).not.toBeInTheDocument();
  });
});

describe('DiskCleanupPage, the review in more detail', () => {
  it('goes back to the list when the review has no scan behind it', async () => {
    page({}, '/?cache=nuget');
    expect(await screen.findByText(/see what your tools are keeping/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'NuGet' })).not.toBeInTheDocument();
  });

  it('tries a version again by itself, without asking a second time', async () => {
    const failed = {
      itemId: nugetItems[0]?.id ?? '',
      label: 'acornima 1.0.0',
      reason: 'It is in use by another program.',
    };
    const view = await scanned({
      'systemCleanup.clean': async (_request: string, _scan: string, selection: CleanSelection) =>
        cleanResult(
          'nuget',
          selection.mode === 'items' && selection.itemIds.length === 1
            ? { removed: 1, failed: [] }
            : { removed: 1, failed: [failed] },
        ),
    });
    await view.user.click(within(card('NuGet')).getByRole('button', { name: /review nuget/i }));
    await view.user.click(await screen.findByRole('button', { name: /delete 300 mb/i }));
    await view.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /delete 300 mb/i }),
    );
    const retry = await screen.findByRole('button', { name: /try again: acornima 1\.0\.0/i });
    await view.user.click(retry);
    await waitFor(() => expect(view.bridge.$fn('systemCleanup.clean')).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const second = view.bridge.$fn('systemCleanup.clean').mock.calls[1]?.[2] as CleanSelection;
    expect(second).toEqual({ mode: 'items', providerId: 'nuget', itemIds: [failed.itemId] });
  });

  it('shows the folder from inside a review', async () => {
    const view = await scanned();
    await view.user.click(within(card('NuGet')).getByRole('button', { name: /review nuget/i }));
    // The cards have this button too, so wait until the review has replaced them.
    await screen.findByRole('heading', { level: 2, name: 'NuGet' });
    await view.user.click(screen.getByRole('button', { name: /show nuget in its folder/i }));
    expect(view.bridge.$fn('systemCleanup.reveal')).toHaveBeenCalledWith('nuget');
  });
});
