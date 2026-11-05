import {
  assessRoot,
  type CacheProvider,
  candidateRoots,
  type DevOs,
  type RootCandidate,
  type SafetyContext,
  winPath,
} from '@runova/core';
import { limiter } from '../util/limiter';

/**
 * Finding where each tool keeps its cache on this machine. Everything that touches the machine is
 * handed in, so the order of the search and the refusals are tested without one.
 *
 * Order: the environment variable that names the cache, what the tool itself reports (only for the
 * handful of tools that are asked, and only if they are installed), then where the tool puts it by
 * default. The first candidate that is a real folder and passes the safety rules wins. A candidate
 * that fails them (a variable that names the home folder) is skipped, not trusted.
 */

export interface LocationDeps {
  os: DevOs;
  env: NodeJS.ProcessEnv;
  home: string;
  safety: SafetyContext;
  /** Whether a command is installed. Nothing is run to find out. */
  hasTool(command: string): boolean;
  /** Runs a tool and returns what it printed, or null if it failed or took too long. */
  query(command: string, args: string[]): Promise<string | null>;
  isDirectory(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  /** The names in a folder, or none if it cannot be read. */
  listDirectory(path: string): Promise<string[]>;
}

export interface ResolvedLocation {
  provider: CacheProvider;
  status: 'found' | 'missing' | 'refused';
  /** The folder as the person would recognise it. */
  root: string | null;
  /** The same folder with every link followed. Every check and every removal uses this one. */
  realRoot: string | null;
  source: RootCandidate['source'] | null;
  /** Why a folder was refused. */
  reason?: string;
  /** Whether the tool that cleans this cache is installed. */
  tools: { clear: boolean; tidy: boolean };
}

/** Most tools asked where their cache is at once. They start processes, and a cold one is slow. */
const MOST_QUERIES_AT_ONCE = 4;

/**
 * Microsoft Store Python runs in a sandbox, and pip keeps its cache inside the package's own
 * folder under Packages. `pip cache dir` says so, but pip may not be on PATH, so look there too.
 */
async function storePythonCaches(
  provider: CacheProvider,
  deps: LocationDeps,
): Promise<RootCandidate[]> {
  if (provider.id !== 'pip' || deps.os !== 'win32') return [];
  const local = deps.env.LOCALAPPDATA?.trim();
  if (!local) return [];
  const packages = winPath.join(local, 'Packages');
  const names = await deps.listDirectory(packages);
  return names
    .filter((name) => name.startsWith('PythonSoftwareFoundation.Python.'))
    .map((name) => ({
      path: winPath.join(packages, name, 'LocalCache', 'Local', 'pip', 'cache'),
      source: 'default' as const,
    }));
}

export async function resolveLocations(
  providers: readonly CacheProvider[],
  deps: LocationDeps,
): Promise<ResolvedLocation[]> {
  const ask = limiter(MOST_QUERIES_AT_ONCE);

  async function resolveOne(provider: CacheProvider): Promise<ResolvedLocation> {
    const tools = {
      clear: provider.clearCommand ? deps.hasTool(provider.clearCommand.command) : false,
      tidy: provider.tidyCommand ? deps.hasTool(provider.tidyCommand.command) : false,
    };
    const query = provider.locate.query;
    const answer =
      query && deps.hasTool(query.command)
        ? await ask(() => deps.query(query.command, query.args))
        : null;

    const candidates = [
      ...candidateRoots(provider, { os: deps.os, env: deps.env, home: deps.home }, answer),
      ...(await storePythonCaches(provider, deps)),
    ];

    let refusal: string | undefined;
    for (const candidate of candidates) {
      if (!(await deps.isDirectory(candidate.path))) continue;
      const real = await deps.realpath(candidate.path).catch(() => candidate.path);
      const verdict = assessRoot(real, deps.safety);
      if (!verdict.ok) {
        refusal ??= verdict.reason;
        continue;
      }
      return {
        provider,
        status: 'found',
        root: candidate.path,
        realRoot: real,
        source: candidate.source,
        tools,
      };
    }
    if (refusal !== undefined) {
      return {
        provider,
        status: 'refused',
        root: null,
        realRoot: null,
        source: null,
        reason: refusal,
        tools,
      };
    }
    return { provider, status: 'missing', root: null, realRoot: null, source: null, tools };
  }

  return Promise.all(providers.map(resolveOne));
}
