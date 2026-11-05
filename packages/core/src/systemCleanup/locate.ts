import { expandPathTemplate, type PathTemplateContext } from '../devSetup/catalog.js';
import { type PathFlavour, pathFlavour } from './paths.js';
import type { CacheProvider } from './types.js';

/**
 * Where a cache might be, in the order to try. The answer is a list of candidates, not a verdict:
 * the main process picks the first one that is a real folder laid out the way the cache should be.
 *
 * Order: the environment variable that names the cache, then what the tool itself reports (asked
 * only for a few tools), then where the tool puts it by default.
 */

export type LocateContext = PathTemplateContext;

export interface RootCandidate {
  path: string;
  source: 'env' | 'query' | 'default';
}

function readEnv(ctx: LocateContext, name: string): string | undefined {
  const exact = ctx.env[name]?.trim();
  if (exact) return exact;
  if (ctx.os !== 'win32') return undefined;
  // Windows variable names are case-insensitive, but a copied environment object is not.
  const key = Object.keys(ctx.env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? ctx.env[key]?.trim() || undefined : undefined;
}

export function candidateRoots(
  provider: CacheProvider,
  ctx: LocateContext,
  queried?: string | null,
): RootCandidate[] {
  const path: PathFlavour = pathFlavour(ctx.os);
  const found: RootCandidate[] = [];
  const seen = new Set<string>();
  const caseInsensitive = ctx.os !== 'linux';

  const add = (raw: string | null | undefined, source: RootCandidate['source'], sub?: string) => {
    if (!raw) return;
    const base = raw.trim();
    if (!path.isAbsolute(base)) return;
    const tidy = path.normalize(sub ? path.join(base, sub) : base);
    const key = caseInsensitive ? tidy.toLowerCase() : tidy;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path: tidy, source });
  };

  for (const variable of provider.locate.env) {
    const value = readEnv(ctx, variable.name);
    const chosen = variable.first && value ? value.split(path.delimiter)[0] : value;
    add(chosen, 'env', variable.sub);
  }

  const query = provider.locate.query;
  if (query && queried) add(query.parse(queried), 'query', query.sub);

  for (const template of provider.locate.defaults[ctx.os]) {
    add(expandPathTemplate(template, ctx), 'default');
  }
  return found;
}
