import type { PackageInfo, PackageManagerSection, RuntimeTarget } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { project } from '../health/testing/fixtures';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { PackagesTab } = await import('./PackagesTab');

/**
 * BitIronPlatform's shape: a bun web app with no root lockfile, and a Flutter app whose Dart
 * constraint is behind. The tab has to name the manager each section really uses and show the
 * runtime rows next to the packages.
 */

function pkg(overrides: Partial<PackageInfo>): PackageInfo {
  return {
    name: 'next',
    currentVersion: '16.0.0',
    latestVersion: '16.0.0',
    isOutdated: false,
    isDev: false,
    isInstalled: true,
    manifestPath: 'C:\\work\\bitiron\\web\\package.json',
    projectLabel: 'bitiron-web',
    ...overrides,
  };
}

const dartSdk: RuntimeTarget = {
  kind: 'dart',
  source: 'pubspec-sdk',
  declared: '^3.11.5',
  currentVersion: '3.11.5',
  latestVersion: '3.13.5',
  isOutdated: true,
  nextDeclared: '^3.13.5',
  requires: { toolchain: 'flutter', minVersion: '3.47.7' },
  manifestPath: 'C:\\work\\bitiron\\app\\pubspec.yaml',
  projectLabel: 'app',
};

const bunSection: PackageManagerSection = {
  ecosystem: 'node',
  manager: 'bun',
  status: 'ok',
  message: null,
  packages: [pkg({})],
  runtimes: [],
  toolchain: 'bun',
};

const dartSection: PackageManagerSection = {
  ecosystem: 'dart',
  manager: 'pub',
  status: 'ok',
  message: null,
  packages: [
    pkg({
      name: 'http',
      currentVersion: '1.2.0',
      latestVersion: '1.2.0',
      manifestPath: dartSdk.manifestPath,
      projectLabel: 'app',
    }),
  ],
  runtimes: [dartSdk],
  toolchain: 'flutter',
};

function renderTab() {
  return renderWithProviders(<PackagesTab project={project()} />, {
    bridge: {
      'packages.list': { projectId: 'p1', sections: [bunSection, dartSection] },
      'devSetup.detect': async (id: string) =>
        id === 'flutter'
          ? { state: 'found', version: '3.47.7', path: 'x', onPath: true }
          : { state: 'found', version: '1.3.2', path: 'x', onPath: true },
      'devSetup.updates': async (ids: string[]) =>
        Object.fromEntries(ids.map((id) => [id, { state: 'current' }])),
    },
  });
}

function sectionOf(heading: string): HTMLElement {
  const title = screen.getByText(heading, { selector: 'p' });
  return title.closest('.glass') as HTMLElement;
}

describe('PackagesTab', () => {
  it.each([
    ['python', 'pip', 'PyPI (pip)'],
    ['python', 'uv', 'PyPI (uv)'],
    ['python', 'poetry', 'PyPI (Poetry)'],
    ['python', 'pipenv', 'PyPI (Pipenv)'],
    ['rust', 'cargo', 'Cargo (Rust)'],
    ['kotlin', 'gradle', 'Gradle (Kotlin / Android)'],
    ['swift', 'spm', 'Swift Package Manager (iOS)'],
    ['swift', 'cocoapods', 'CocoaPods (iOS)'],
  ] as const)('names a %s section managed by %s', async (ecosystem, manager, label) => {
    renderWithProviders(<PackagesTab project={project()} />, {
      bridge: {
        'packages.list': {
          projectId: 'p1',
          sections: [{ ...bunSection, ecosystem, manager, toolchain: null }],
        },
      },
    });

    expect(await screen.findByText(label, { selector: 'p' })).toBeInTheDocument();
  });

  it('names every manifest it looks for when it finds none', async () => {
    renderWithProviders(<PackagesTab project={project()} />, {
      bridge: { 'packages.list': { projectId: 'p1', sections: [] } },
    });

    const message = await screen.findByText(/Runova looks for/);
    for (const manifest of [
      'pyproject.toml',
      'requirements.txt',
      'Pipfile',
      'Cargo.toml',
      'build.gradle',
      'Package.swift',
      'Podfile',
    ]) {
      expect(message.textContent).toContain(manifest);
    }
  });

  it('labels the web app section Bun and shows its toolchain', async () => {
    renderTab();

    await screen.findByText('Bun', { selector: 'p' });
    const bun = sectionOf('Bun');
    expect(within(bun).getByText('Runtime')).toBeInTheDocument();
    expect(await within(bun).findByText('installed on this machine')).toBeInTheDocument();
    expect(screen.queryByText('npm', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('counts an outdated runtime as outdated, and lets the AI dialog open for it', async () => {
    const { user } = renderTab();

    await screen.findByText('pub (Dart / Flutter)', { selector: 'p' });
    const dart = sectionOf('pub (Dart / Flutter)');
    expect(within(dart).getByText('1 outdated')).toBeInTheDocument();
    expect(within(dart).getByText('Dart SDK')).toBeInTheDocument();
    // The toolbar adds it to the project total too.
    expect(screen.getAllByText('1 outdated')).toHaveLength(2);

    const ai = within(dart).getByRole('button', { name: 'Update with AI' });
    expect(ai).toBeEnabled();
    await user.click(ai);
    // Not ticked, so not in the prompt.
    expect(
      await screen.findByText(
        'Nothing is in the prompt. Tick a package or runtime in the list to add it.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the runtime rows under the Outdated filter and hides them while searching', async () => {
    const { user } = renderTab();
    await screen.findByText('Dart SDK');

    await user.click(screen.getByRole('radio', { name: /Outdated/ }));
    expect(screen.getByText('Dart SDK')).toBeInTheDocument();
    // The bun section has nothing outdated, so it drops out.
    expect(screen.queryByText('Bun', { selector: 'p' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'All' }));
    await user.type(screen.getByRole('textbox', { name: 'Search packages' }), 'http');
    expect(screen.queryByText('Dart SDK')).not.toBeInTheDocument();
  });

  it('says everything is up to date under Outdated and goes back to All from there', async () => {
    const { user } = renderWithProviders(<PackagesTab project={project()} />, {
      bridge: {
        'packages.list': { projectId: 'p1', sections: [bunSection] },
        'devSetup.detect': async () => ({
          state: 'found',
          version: '1.3.2',
          path: 'x',
          onPath: true,
        }),
        'devSetup.updates': async (ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, { state: 'current' }])),
      },
    });
    await screen.findByText('Bun', { selector: 'p' });

    await user.click(screen.getByRole('radio', { name: /Outdated/ }));
    expect(screen.getByText('Everything is up to date')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show all packages' }));
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
    expect(screen.queryByText('Everything is up to date')).not.toBeInTheDocument();
  });
});

describe('selecting what goes in the AI prompt', () => {
  const outdatedPkg = (name: string, from: string, to: string) =>
    pkg({ name, currentVersion: from, latestVersion: to, isOutdated: true });
  const react = outdatedPkg('react', '18.3.1', '19.1.0');
  const zod = outdatedPkg('zod', '3.22.0', '3.24.1');
  const vite = outdatedPkg('vite', '6.0.0', '6.0.3');
  const bunPin: RuntimeTarget = {
    kind: 'bun',
    source: 'packageManager',
    declared: 'bun@1.1.0',
    currentVersion: '1.1.0',
    latestVersion: '1.3.2',
    isOutdated: true,
    nextDeclared: 'bun@1.3.2',
    requires: null,
    manifestPath: 'C:\\work\\bitiron\\web\\package.json',
    projectLabel: 'bitiron-web',
  };
  const outdatedBun: PackageManagerSection = {
    ...bunSection,
    packages: [react, zod, vite],
    runtimes: [bunPin],
    toolchain: null,
  };

  function renderOutdated() {
    return renderWithProviders(<PackagesTab project={project()} />, {
      bridge: { 'packages.list': { projectId: 'p1', sections: [outdatedBun] } },
    });
  }

  function promptText(): string {
    return screen.getByRole('region', { name: 'Prompt for your agent' }).textContent ?? '';
  }

  it('counts only the ticked packages and puts only them in the prompt', async () => {
    const { user } = renderOutdated();
    await screen.findByText('Bun', { selector: 'p' });
    await user.click(screen.getByRole('radio', { name: /Outdated/ }));

    await user.click(screen.getByRole('checkbox', { name: 'Select zod' }));
    expect(screen.getByRole('button', { name: 'Update 1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clear 1 selected' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Update with AI' }));
    await screen.findByRole('dialog');
    expect(screen.getByText('1 selected package')).toBeInTheDocument();
    expect(screen.queryByText(/All 3 outdated/)).not.toBeInTheDocument();
    expect(promptText()).toContain('Update 1 outdated bun package ');
    expect(promptText()).toContain('- zod: 3.22.0 -> 3.24.1');
    expect(promptText()).not.toContain('react');
    expect(promptText()).not.toContain('vite');
    // The runtime is outdated, but it is not ticked.
    expect(promptText()).not.toContain('bun@1.3.2');
  });

  it('adds a runtime to the prompt only once its row is ticked', async () => {
    const { user } = renderOutdated();
    await screen.findByText('Bun', { selector: 'p' });
    await user.click(screen.getByRole('radio', { name: /Outdated/ }));

    await user.click(screen.getByRole('checkbox', { name: 'Select zod' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Bun (packageManager)' }));
    // Update N runs package updates, so it counts the packages only.
    expect(screen.getByRole('button', { name: 'Update 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear 2 selected' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Update with AI' }));
    await screen.findByRole('dialog');
    expect(promptText()).toContain('Runtime (current -> target):');
    expect(promptText()).toContain('bun@1.1.0 -> bun@1.3.2');
    expect(promptText()).toContain('- zod: 3.22.0 -> 3.24.1');
    expect(promptText()).not.toContain('react');
  });

  it('copies a prompt with only the ticked packages and runtimes', async () => {
    const { user } = renderOutdated();
    await screen.findByText('Bun', { selector: 'p' });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');

    await user.click(screen.getByRole('checkbox', { name: 'Select vite' }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copy 1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /AI update prompt/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const first = writeText.mock.calls.at(-1)?.[0] ?? '';
    expect(first).toContain('- vite: 6.0.0 -> 6.0.3');
    expect(first).not.toContain('react');
    expect(first).not.toContain('Runtime (current -> target):');

    await user.click(screen.getByRole('checkbox', { name: 'Select Bun (packageManager)' }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copy 2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /AI update prompt/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const second = writeText.mock.calls.at(-1)?.[0] ?? '';
    expect(second).toContain('bun@1.1.0 -> bun@1.3.2');
    expect(second).toContain('- vite: 6.0.0 -> 6.0.3');
    expect(second).not.toContain('zod');
  });

  it('copies every outdated package and no runtime when nothing is ticked', async () => {
    const { user } = renderOutdated();
    await screen.findByText('Bun', { selector: 'p' });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copy 3 outdated')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /AI update prompt/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls.at(-1)?.[0] ?? '';
    expect(copied).toContain('Update 3 outdated bun packages');
    expect(copied).not.toContain('Runtime (current -> target):');
  });

  it('clears the ticked runtime with the packages', async () => {
    const { user } = renderOutdated();
    await screen.findByText('Bun', { selector: 'p' });
    await user.click(screen.getByRole('checkbox', { name: 'Select react' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Bun (packageManager)' }));

    await user.click(screen.getByRole('button', { name: 'Clear 2 selected' }));
    expect(screen.getByRole('checkbox', { name: 'Select Bun (packageManager)' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select react' })).not.toBeChecked();
  });
});

/**
 * The pnpm pin in a package.json, as a scan reads it before and after the Update button rewrites
 * it.
 */
function pnpmPin(outdated: boolean): RuntimeTarget {
  return {
    kind: 'pnpm',
    source: 'packageManager',
    declared: outdated ? 'pnpm@12.4.1' : 'pnpm@12.16.1',
    currentVersion: outdated ? '12.4.1' : '12.16.1',
    latestVersion: '12.16.1',
    isOutdated: outdated,
    nextDeclared: outdated ? 'pnpm@12.16.1' : null,
    requires: null,
    manifestPath: 'C:\\work\\runova\\package.json',
    projectLabel: 'runova',
  };
}

function pnpmSection(outdated: boolean): PackageManagerSection {
  return {
    ecosystem: 'node',
    manager: 'pnpm',
    status: 'ok',
    message: null,
    packages: [],
    runtimes: [pnpmPin(outdated)],
    toolchain: null,
  };
}

describe('updating a pinned runtime', () => {
  it('shows the pin as current once the rewrite is done', async () => {
    let onDisk = true;
    const { user } = renderWithProviders(<PackagesTab project={project()} />, {
      bridge: {
        'packages.list': async () => ({ projectId: 'p1', sections: [pnpmSection(onDisk)] }),
        'packages.updateRuntime': async () => {
          onDisk = false;
          return { ok: true, message: 'Updated pnpm@12.4.1 to pnpm@12.16.1.' };
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Update pnpm (packageManager)' }));

    await waitFor(() => expect(screen.getByText('pnpm@12.16.1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Update pnpm (packageManager)' })).toBeNull();
    expect(screen.queryByText('1 outdated')).toBeNull();
  });

  it('does not bring back the old pin when a scan that started before the rewrite finishes late', async () => {
    let onDisk = true;
    let releaseSlowScan: (() => void) | undefined;
    let scans = 0;
    const { user, queryClient } = renderWithProviders(<PackagesTab project={project()} />, {
      bridge: {
        'packages.list': async () => {
          scans += 1;
          const found = pnpmSection(onDisk);
          // The second scan is the slow one: it read the file before the update ran.
          if (scans === 2) await new Promise<void>((resolve) => (releaseSlowScan = resolve));
          return { projectId: 'p1', sections: [found] };
        },
        'packages.updateRuntime': async () => {
          onDisk = false;
          return { ok: true, message: 'Updated pnpm@12.4.1 to pnpm@12.16.1.' };
        },
      },
    });

    await screen.findByRole('button', { name: 'Update pnpm (packageManager)' });
    // Come back to the tab with stale data on screen and a scan running behind it.
    void queryClient.invalidateQueries({ queryKey: ['packages', 'p1'] });
    await waitFor(() => expect(scans).toBe(2));

    await user.click(screen.getByRole('button', { name: 'Update pnpm (packageManager)' }));
    await waitFor(() => expect(scans).toBeGreaterThanOrEqual(3));
    releaseSlowScan?.();

    await waitFor(() => expect(screen.getByText('pnpm@12.16.1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Update pnpm (packageManager)' })).toBeNull();
  });

  it('does not wait for the rescan to show the pin as current', async () => {
    // A scan covers every ecosystem in the project (pnpm, npm, NuGet) and can take a long time
    // on a slow network, so the row cannot depend on it to flip.
    let onDisk = true;
    let scans = 0;
    const { user } = renderWithProviders(<PackagesTab project={project()} />, {
      bridge: {
        'packages.list': async () => {
          scans += 1;
          if (scans > 1) return new Promise<never>(() => undefined);
          return { projectId: 'p1', sections: [pnpmSection(onDisk)] };
        },
        'packages.updateRuntime': async () => {
          onDisk = false;
          return { ok: true, message: 'Updated pnpm@12.4.1 to pnpm@12.16.1.' };
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Update pnpm (packageManager)' }));

    await waitFor(() => expect(scans).toBe(2));
    await waitFor(() => expect(screen.getByText('pnpm@12.16.1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Update pnpm (packageManager)' })).toBeNull();
    expect(screen.queryByText('1 outdated')).toBeNull();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    // The rescan is still running and will have the last word.
    expect(screen.getByRole('button', { name: 'Scanning…' })).toBeInTheDocument();
  });
});
