/**
 * Dependency alerts (E51): the packages the app uploads for each project, and what the server
 * sends back about them. Only ecosystem, name and version leave the computer, never a path.
 */

export type InventoryEcosystem = 'npm' | 'nuget' | 'pub';

export interface InventoryPackage {
  ecosystem: InventoryEcosystem;
  name: string;
  version: string;
  dev: boolean;
}

const VERSION_START = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/i;

/**
 * The version a manifest entry stands for: the installed or locked one when it is exact, else the
 * oldest a range allows (`^4.17.20` is 4.17.20, `1.x` is 1.0.0, `[2.1.35]` is 2.1.35). Null for
 * anything that is not from a registry (`workspace:*`, `file:`, a git or tarball URL, an alias) or
 * names no version at all (`*`, `latest`).
 */
export function baseVersion(text: string | null | undefined): string | null {
  const source = (text ?? '').trim();
  if (!source || source.includes(':') || source.includes('/')) return null;
  const first = source
    .split('||')[0]
    .trim()
    .replace(/^[\^~=<>v[(\s]+/i, '');
  const match = VERSION_START.exec(first);
  if (!match) return null;
  const part = (value: string | undefined) =>
    value === undefined || /^[x*]$/i.test(value) ? '0' : value;
  const core = [match[1], part(match[2]), part(match[3])];
  if (match[4] !== undefined) core.push(match[4]);
  return match[5] ? `${core.join('.')}-${match[5]}` : core.join('.');
}

/** One entry per package (NuGet names ignore case), the first one seen kept, sorted by name. */
export function tidyInventory(packages: InventoryPackage[]): InventoryPackage[] {
  const seen = new Map<string, InventoryPackage>();
  for (const pkg of packages) {
    const key = `${pkg.ecosystem}:${pkg.name.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, pkg);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.ecosystem.localeCompare(b.ecosystem),
  );
}

export type FindingKind = 'security' | 'deprecated' | 'major' | 'minor' | 'patch';

export type AdvisorySeverity = 'critical' | 'high' | 'moderate' | 'low';

export type SecurityThreshold = AdvisorySeverity | 'off';

export interface DependencyFinding {
  ecosystem: InventoryEcosystem;
  name: string;
  kind: FindingKind;
  currentVersion: string;
  targetVersion: string | null;
  advisoryId: string | null;
  severity: AdvisorySeverity | null;
  summary: string | null;
  firstSeenAt: string;
}

export interface ProjectFindings {
  inventoryId: number;
  scopeId: number;
  itemId: string;
  projectName: string;
  muted: boolean;
  lastCheckedAt: string | null;
  total: number;
  worstSeverity: AdvisorySeverity | null;
  counts: Record<FindingKind, number>;
  findings: DependencyFinding[];
}

export interface DependencyFindingsView {
  enabled: boolean;
  total: number;
  items: ProjectFindings[];
}

export interface DependencyAlertSettings {
  enabled: boolean;
  securityMinSeverity: SecurityThreshold;
  deprecated: boolean;
  major: boolean;
  minor: boolean;
  patch: boolean;
  inApp: boolean;
  telegram: boolean;
}

export interface TelegramLinkView {
  available: boolean;
  linked: boolean;
  botUsername: string | null;
  chatName: string | null;
  linkedAt: string | null;
}

export interface ServerNotification {
  id: number;
  kind: string;
  title: string;
  body: string;
  severity: AdvisorySeverity | null;
  scopeId: number | null;
  itemId: string | null;
  inventoryId: number | null;
  createdAt: string;
  readAt: string | null;
}

/** What the renderer sees: the findings, keyed by the local project id, and whether the app can use the feature. */
export interface DependencyAlertsSummary {
  /** False when signed out: the feature lives on the account. */
  signedIn: boolean;
  enabled: boolean;
  /** Projects with something to tell, not counting muted ones. */
  projectsWithAlerts: number;
  total: number;
  byProject: Record<string, ProjectFindings>;
}

export const EMPTY_DEPENDENCY_SUMMARY: DependencyAlertsSummary = {
  signedIn: false,
  enabled: false,
  projectsWithAlerts: 0,
  total: 0,
  byProject: {},
};
