import { CACHE_PROVIDERS, getProvider, type SafetyContext } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { type LocationDeps, resolveLocations } from './locations';

const safety: SafetyContext = {
  os: 'win32',
  home: 'C:\\Users\\me',
  protectedFolders: ['C:\\Users\\me\\Documents', 'C:\\Windows'],
  projectFolders: ['C:\\dev\\app'],
};

interface FakeOptions {
  folders?: string[];
  tools?: string[];
  answers?: Record<string, string | null>;
  env?: NodeJS.ProcessEnv;
  real?: Record<string, string>;
  listed?: Record<string, string[]>;
}

function fake(
  options: FakeOptions = {},
): LocationDeps & { asked: string[]; running: number; peak: number } {
  const folders = new Set((options.folders ?? []).map((path) => path.toLowerCase()));
  const tools = new Set(options.tools ?? []);
  const state = { asked: [] as string[], running: 0, peak: 0 };
  return Object.assign(state, {
    os: 'win32' as const,
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ...options.env },
    home: 'C:\\Users\\me',
    safety,
    hasTool: (command: string) => tools.has(command),
    isDirectory: async (path: string) => folders.has(path.toLowerCase()),
    realpath: async (path: string) => options.real?.[path] ?? path,
    listDirectory: async (path: string) => options.listed?.[path] ?? [],
    query: async (command: string, args: string[]) => {
      const key = [command, ...args].join(' ');
      state.asked.push(key);
      state.running += 1;
      state.peak = Math.max(state.peak, state.running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.running -= 1;
      return options.answers?.[key] ?? null;
    },
  });
}

const only = (id: string) => CACHE_PROVIDERS.filter((provider) => provider.id === id);

describe('resolveLocations', () => {
  it('finds a cache in its usual place when the folder is there', async () => {
    const [found] = await resolveLocations(
      only('nuget'),
      fake({ folders: ['C:\\Users\\me\\.nuget\\packages'] }),
    );
    expect(found).toMatchObject({
      status: 'found',
      root: 'C:\\Users\\me\\.nuget\\packages',
      source: 'default',
    });
  });

  it('says a cache is missing when no candidate is a folder', async () => {
    const [found] = await resolveLocations(only('nuget'), fake());
    expect(found).toMatchObject({ status: 'missing', root: null });
  });

  it('prefers the folder an environment variable names', async () => {
    const [found] = await resolveLocations(
      only('nuget'),
      fake({
        env: { NUGET_PACKAGES: 'D:\\nuget' },
        folders: ['D:\\nuget', 'C:\\Users\\me\\.nuget\\packages'],
      }),
    );
    expect(found).toMatchObject({ root: 'D:\\nuget', source: 'env' });
  });

  it('asks the tool where its cache is, when the tool is installed, and uses the answer', async () => {
    const deps = fake({
      tools: ['dotnet'],
      answers: { 'dotnet nuget locals global-packages --list': 'global-packages: E:\\pkgs\\\r\n' },
      folders: ['E:\\pkgs', 'C:\\Users\\me\\.nuget\\packages'],
    });
    const [found] = await resolveLocations(only('nuget'), deps);
    expect(found).toMatchObject({ root: 'E:\\pkgs', source: 'query' });
    expect(deps.asked).toEqual(['dotnet nuget locals global-packages --list']);
  });

  it('does not run a tool that is not installed', async () => {
    const deps = fake({ folders: ['C:\\Users\\me\\.nuget\\packages'] });
    await resolveLocations(only('nuget'), deps);
    expect(deps.asked).toEqual([]);
  });

  it('falls back to the usual place when the tool gives no answer', async () => {
    const deps = fake({ tools: ['dotnet'], folders: ['C:\\Users\\me\\.nuget\\packages'] });
    const [found] = await resolveLocations(only('nuget'), deps);
    expect(found?.root).toBe('C:\\Users\\me\\.nuget\\packages');
  });

  it('never asks a tool for a cache that is found by its folder alone', async () => {
    const deps = fake({
      tools: ['gradle', 'mvn', 'flutter', 'dart', 'cargo'],
      folders: ['C:\\Users\\me\\.gradle\\caches', 'C:\\Users\\me\\.cargo\\registry'],
    });
    await resolveLocations(CACHE_PROVIDERS, deps);
    expect(deps.asked).toEqual([]);
  });

  it('asks at most a few tools at once', async () => {
    const deps = fake({ tools: ['npm', 'pnpm', 'bun', 'dotnet', 'pip', 'go'] });
    await resolveLocations(CACHE_PROVIDERS, deps);
    expect(deps.asked.length).toBeGreaterThanOrEqual(6);
    expect(deps.peak).toBeLessThanOrEqual(4);
  });

  describe('refusing a folder that is not safe to treat as a cache', () => {
    it('refuses a variable that names the home folder, and uses the next place that is safe', async () => {
      const [found] = await resolveLocations(
        only('nuget'),
        fake({
          env: { NUGET_PACKAGES: 'C:\\Users\\me' },
          folders: ['C:\\Users\\me', 'C:\\Users\\me\\.nuget\\packages'],
        }),
      );
      expect(found).toMatchObject({ status: 'found', root: 'C:\\Users\\me\\.nuget\\packages' });
    });

    it('reports a refusal, with the reason, when nothing safe is left', async () => {
      const [found] = await resolveLocations(
        only('nuget'),
        fake({
          env: { NUGET_PACKAGES: 'C:\\Users\\me\\Documents\\pkgs' },
          folders: ['C:\\Users\\me\\Documents\\pkgs'],
        }),
      );
      expect(found).toMatchObject({ status: 'refused', root: null });
      expect(found?.reason).toMatch(/protected/i);
    });

    it('judges the real folder, so a link into Documents does not get through', async () => {
      const [found] = await resolveLocations(
        only('nuget'),
        fake({
          env: { NUGET_PACKAGES: 'D:\\shortcut' },
          folders: ['D:\\shortcut'],
          real: { 'D:\\shortcut': 'C:\\Users\\me\\Documents\\real' },
        }),
      );
      expect(found?.status).toBe('refused');
    });

    it('keeps the real folder for its own use and the one the person knows for showing', async () => {
      const [found] = await resolveLocations(
        only('nuget'),
        fake({
          env: { NUGET_PACKAGES: 'D:\\link' },
          folders: ['D:\\link'],
          real: { 'D:\\link': 'E:\\actual\\packages' },
        }),
      );
      expect(found).toMatchObject({
        status: 'found',
        root: 'D:\\link',
        realRoot: 'E:\\actual\\packages',
      });
    });
  });

  it('looks for pip in the folder Microsoft Store Python keeps it in', async () => {
    const store =
      'C:\\Users\\me\\AppData\\Local\\Packages\\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\\LocalCache\\Local\\pip\\cache';
    const [found] = await resolveLocations(
      only('pip'),
      fake({
        listed: {
          'C:\\Users\\me\\AppData\\Local\\Packages': [
            'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
            'PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0',
          ],
        },
        folders: [store],
      }),
    );
    expect(found).toMatchObject({ status: 'found', root: store });
  });

  it('says whether the tool that cleans a cache is installed', async () => {
    const npm = only('npm');
    const without = await resolveLocations(
      npm,
      fake({ folders: ['C:\\Users\\me\\AppData\\Local\\npm-cache\\_cacache'] }),
    );
    expect(without[0]?.tools).toEqual({ clear: false, tidy: false });
    const withNpm = await resolveLocations(
      npm,
      fake({ tools: ['npm'], folders: ['C:\\Users\\me\\AppData\\Local\\npm-cache\\_cacache'] }),
    );
    expect(withNpm[0]?.tools).toEqual({ clear: true, tidy: false });
  });

  it('answers for every provider it is given, in order', async () => {
    const found = await resolveLocations(CACHE_PROVIDERS, fake());
    expect(found.map((entry) => entry.provider.id)).toEqual(CACHE_PROVIDERS.map((p) => p.id));
    expect(found.every((entry) => entry.status === 'missing')).toBe(true);
    expect(getProvider('bun').id).toBe('bun');
  });
});
