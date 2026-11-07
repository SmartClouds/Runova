/**
 * Shared vocabulary for project security scans.
 *
 * Six very different tools feed this: SAST engines (Semgrep, CodeQL, Bearer), a dependency and
 * secret scanner (Trivy), a quality platform (SonarQube), and an autonomous pentest agent (Strix).
 * Each speaks its own dialect, so everything is normalized into one finding shape here and the
 * report never has to care which tool produced a row.
 *
 * Deliberately parallel to the skills audit in ../skills/securityAudit.ts, so the two reports
 * read the same way even though they scan completely different things.
 */

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Worst first, which is also the order the report lists severities in. */
export const SECURITY_SEVERITIES: SecuritySeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export const SECURITY_SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export type SecurityScannerId = 'semgrep' | 'codeql' | 'trivy' | 'bearer' | 'sonarqube' | 'strix';

/** What sort of problem a finding is, which is not the same as which tool found it. */
export type SecurityFindingKind =
  | 'sast'
  | 'dependency'
  | 'secret'
  | 'misconfig'
  | 'hotspot'
  | 'dast';

export const SECURITY_FINDING_KIND_LABEL: Record<SecurityFindingKind, string> = {
  sast: 'Code',
  dependency: 'Dependency',
  secret: 'Secret',
  misconfig: 'Misconfiguration',
  hotspot: 'Needs review',
  dast: 'Exploited',
};

/**
 * What a scanner actually looks for. Shown on the picker card so the user can tell at a glance
 * why they would run two of these rather than one.
 */
export type SecurityScannerKind = 'sast' | 'sca' | 'secrets' | 'iac' | 'quality' | 'dast';

export const SECURITY_SCANNER_KIND_LABEL: Record<SecurityScannerKind, string> = {
  sast: 'Static analysis',
  sca: 'Dependency CVEs',
  secrets: 'Secrets',
  iac: 'Infrastructure as code',
  quality: 'Code quality',
  dast: 'Dynamic pentest',
};

/**
 * A requirement that has to hold before a scanner can run. Preflight turns each of these into a
 * pass or a blocked reason, so the UI can say "install it" or "set a token" instead of failing
 * halfway through a run.
 */
export type ScannerRequirementId =
  | 'binary'
  | 'platform'
  | 'docker-running'
  | 'sonar-server'
  | 'sonar-token'
  | 'llm-api-key'
  | 'language';

export type RequirementStatus = 'ok' | 'unmet' | 'unknown';

/** What the UI should offer to do about an unmet requirement. */
export type RequirementAction =
  | { kind: 'install-tool'; toolId: string }
  | { kind: 'start-docker' }
  | { kind: 'start-container'; toolId: string }
  | { kind: 'configure'; scannerId: SecurityScannerId }
  | { kind: 'none' };

export interface ScannerRequirement {
  id: ScannerRequirementId;
  label: string;
  status: RequirementStatus;
  /** Blocking means the scanner is skipped; non-blocking is a warning that still runs. */
  blocking: boolean;
  /** One imperative sentence telling the user how to fix it. */
  remedy: string;
  action: RequirementAction;
  detail: string | null;
}

export interface ScannerPreflight {
  scannerId: SecurityScannerId;
  ready: boolean;
  requirements: ScannerRequirement[];
}

export interface SecurityScannerDescriptor {
  id: SecurityScannerId;
  /** The AGENT_TOOL_REGISTRY id this scanner installs from, so the UI can deep-link to its card. */
  toolId: string;
  name: string;
  /** One line on the picker card: what this tool finds that the others do not. */
  covers: string;
  kinds: SecurityScannerKind[];
  /** Rough wall-clock guess for a mid-sized repo, shown so a slow scanner is not a surprise. */
  estimate: string;
  /**
   * True for scanners that cost money or touch the target at runtime. These are never selected by
   * default and need an explicit confirm.
   */
  costsMoney?: boolean;
  /**
   * Which of the three run phases this scanner belongs to. Fast native scanners go first so the
   * report fills in early; docker scanners are serialized because they thrash the same bind
   * mount; the heavy ones go last so a user can cancel before paying for them.
   */
  phase: 1 | 2 | 3;
  docsUrl: string;
}

export interface SecurityFinding {
  /** Stable within one scan, used as a React key and to address a single finding when copying. */
  id: string;
  scannerId: SecurityScannerId;
  /** The tool's own rule identifier, e.g. a Semgrep rule id or a CVE. */
  ruleId: string;
  title: string;
  detail: string;
  severity: SecuritySeverity;
  /** The tool's own word for it, kept so a badge can explain where the severity came from. */
  nativeSeverity: string | null;
  kind: SecurityFindingKind;
  /** Project-relative, POSIX separators, so it matches what an agent will see. */
  file: string | null;
  line: number | null;
  endLine: number | null;
  /** Source excerpt when the tool gives one; never fabricated by reading the file ourselves. */
  excerpt: string | null;
  cwe: string[];
  owasp: string[];
  cve: string | null;
  packageName: string | null;
  installedVersion: string | null;
  fixedVersion: string | null;
  helpUri: string | null;
  /** The tool's own fix advice, when it ships any. */
  remediation: string | null;
  /**
   * True when a matched secret was masked before this left the main process. Secret scanners put
   * the credential itself in the message, and this report has a copy-to-clipboard button.
   */
  redacted: boolean;
}

export type ScannerRunStatus = 'ok' | 'failed' | 'skipped' | 'cancelled' | 'timed-out';

export interface ScannerRunResult {
  scannerId: SecurityScannerId;
  status: ScannerRunStatus;
  transport: 'native' | 'docker';
  toolVersion: string | null;
  findingCount: number;
  durationMs: number;
  exitCode: number | null;
  /** Set when the per-scanner finding cap clipped the result. */
  truncated: boolean;
  /** Populated for 'failed' and 'skipped'; the blocked-requirement reason for the latter. */
  error: string | null;
  /** Non-fatal notes, e.g. a partial run or a path that could not be relativized. */
  warnings: string[];
  /** Tail of the tool's own output, kept for the failure case so the user can see what broke. */
  log: string | null;
}

export type SecurityVerdict = 'safe' | 'caution' | 'risky' | 'dangerous';

export const SECURITY_VERDICT_LABEL: Record<SecurityVerdict, string> = {
  safe: 'Nothing serious found',
  caution: 'Worth a look',
  risky: 'Needs attention',
  dangerous: 'Fix before shipping',
};

export interface SecurityScanOptions {
  scannerIds: SecurityScannerId[];
  /** Semgrep ruleset: 'auto' reaches semgrep.dev, the p/* ones are registry packs. */
  semgrepConfig: string;
  trivyScanners: ('vuln' | 'secret' | 'misconfig')[];
  codeqlLanguage: string | null;
  codeqlBuildCommand: string | null;
  sonarProjectKey: string | null;
  includeInfo: boolean;
  maxFindingsPerScanner: number;
}

export const DEFAULT_SCAN_OPTIONS: SecurityScanOptions = {
  scannerIds: [],
  semgrepConfig: 'auto',
  trivyScanners: ['vuln', 'secret'],
  codeqlLanguage: null,
  codeqlBuildCommand: null,
  sonarProjectKey: null,
  includeInfo: false,
  maxFindingsPerScanner: 2000,
};

export type SecurityScanStatus = 'complete' | 'partial' | 'cancelled' | 'failed';

export interface SecurityScanRecord {
  id: string;
  projectId: string;
  projectName: string;
  status: SecurityScanStatus;
  verdict: SecurityVerdict;
  score: number;
  findings: SecurityFinding[];
  runs: ScannerRunResult[];
  counts: Record<SecuritySeverity, number>;
  durationMs: number;
  /** The options this run used, so "run again" reproduces it. Never holds a secret. */
  options: SecurityScanOptions;
  createdAt: string;
}

/** Live progress while a scan is in flight. Broadcast from main to every window. */
export type ScanPhase =
  | 'queued'
  | 'preflight'
  | 'pulling-image'
  | 'waiting-for-server'
  | 'creating-database'
  | 'scanning'
  | 'analyzing'
  | 'waiting-for-task'
  | 'fetching-results'
  | 'parsing'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'timed-out';

export const SCAN_PHASE_LABEL: Record<ScanPhase, string> = {
  queued: 'Queued',
  preflight: 'Checking requirements',
  'pulling-image': 'Pulling Docker image',
  'waiting-for-server': 'Waiting for the server',
  'creating-database': 'Building database',
  scanning: 'Scanning',
  analyzing: 'Analyzing',
  'waiting-for-task': 'Waiting for analysis',
  'fetching-results': 'Fetching results',
  parsing: 'Reading results',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  'timed-out': 'Timed out',
};

export interface SecurityScanProgress {
  runId: string;
  projectId: string;
  /** null for run-level events that are not about one scanner. */
  scannerId: SecurityScannerId | null;
  phase: ScanPhase;
  /** Latest line of the tool's output, or a short status like "Building CodeQL database". */
  message: string;
  completedScanners: number;
  totalScanners: number;
  elapsedMs: number;
  /** Set on a scanner's terminal event so its card can settle immediately. */
  run?: ScannerRunResult;
}
