import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest global setup: builds core, protocol and studio when their dist is older than their source.
 *
 * The app imports those packages from their dist folders, so tests run against whatever was built
 * last. After an export is added to core, an old dist turns every caller of it into "x is not a
 * function". The root `pnpm test` builds them first, but running Vitest directly skips that.
 *
 * Nothing is built when dist is current (as it is in CI, which builds the packages before this
 * runs), so a test run in another package that reads dist never sees tsc rewriting it. Set
 * RUNOVA_SKIP_PACKAGE_BUILD=1 to skip the check while iterating.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PACKAGES = ['core', 'protocol', 'studio'];

/** The newest change to a package's own source, leaving out its tests. */
function newestSource(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSource(full));
    } else if (!/\.test\.tsx?$/.test(entry.name)) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function isStale(name: string): boolean {
  const root = join(REPO_ROOT, 'packages', name);
  const built = join(root, 'dist', 'index.js');
  if (!existsSync(built)) return true;
  return newestSource(join(root, 'src')) > statSync(built).mtimeMs;
}

export default function buildPackages(): void {
  if (process.env.RUNOVA_SKIP_PACKAGE_BUILD === '1') return;
  const stale = PACKAGES.filter(isStale);
  if (stale.length === 0) return;
  process.stdout.write(`Building ${stale.join(', ')}: dist is older than the source.\n`);
  execSync('pnpm run build:packages', { cwd: REPO_ROOT, stdio: 'inherit' });
}
