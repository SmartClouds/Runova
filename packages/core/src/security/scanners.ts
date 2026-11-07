import type { SecurityScannerDescriptor, SecurityScannerId } from './types.js';

/**
 * The six scanners the Security tab can run, and what each one is actually for.
 *
 * `phase` is the run order and it is deliberate rather than a scheduler:
 *  1. Fast native file walks, run in parallel, so the report fills in within about a minute.
 *  2. Docker-backed scanners, run one at a time, because they bind-mount the same project and on
 *     Windows the mount, not the CPU, is the bottleneck.
 *  3. The heavy ones, last, so a user who has already seen most of the value can cancel before
 *     CodeQL spends 30 minutes or Strix spends real money.
 */
export const SECURITY_SCANNERS: SecurityScannerDescriptor[] = [
  {
    id: 'semgrep',
    toolId: 'semgrep',
    name: 'Semgrep',
    covers: 'Pattern-based static analysis across 30+ languages. The best first scan to run.',
    kinds: ['sast'],
    estimate: '1 to 5 minutes',
    phase: 1,
    docsUrl: 'https://semgrep.dev/docs/',
  },
  {
    id: 'trivy',
    toolId: 'trivy',
    name: 'Trivy',
    covers: 'Known CVEs in your dependencies, hardcoded secrets, and IaC misconfigurations.',
    kinds: ['sca', 'secrets', 'iac'],
    estimate: '1 to 3 minutes',
    phase: 1,
    docsUrl: 'https://trivy.dev/latest/docs/',
  },
  {
    id: 'bearer',
    toolId: 'bearer',
    name: 'Bearer',
    covers: 'Data-flow analysis that follows sensitive data (PII, tokens) through your code.',
    kinds: ['sast', 'secrets'],
    estimate: '2 to 10 minutes',
    phase: 2,
    docsUrl: 'https://docs.bearer.com/',
  },
  {
    id: 'sonarqube',
    toolId: 'sonarqube',
    name: 'SonarQube',
    covers: 'Vulnerabilities and security hotspots, with a full history on its own dashboard.',
    kinds: ['quality', 'sast'],
    estimate: '5 to 20 minutes',
    phase: 2,
    docsUrl: 'https://docs.sonarsource.com/sonarqube-community-build/',
  },
  {
    id: 'codeql',
    toolId: 'codeql',
    name: 'CodeQL',
    covers:
      'Deep semantic analysis that traces untrusted input to dangerous sinks. Slow, but finds real exploitable paths the pattern scanners miss.',
    kinds: ['sast'],
    estimate: '10 to 45 minutes',
    phase: 3,
    docsUrl: 'https://codeql.github.com/docs/',
  },
  {
    id: 'strix',
    toolId: 'strix',
    name: 'Strix',
    covers:
      'An autonomous agent that runs your code and proves vulnerabilities with real exploits. Costs LLM tokens against your own API key.',
    kinds: ['dast'],
    estimate: '15 to 60 minutes',
    costsMoney: true,
    phase: 3,
    docsUrl: 'https://github.com/usestrix/strix',
  },
];

/**
 * The Bearer image. Bearer has no Windows build, so on Windows every scan runs in this image, and
 * Dev Setup pulls it ahead of the first one.
 */
export const BEARER_DOCKER_IMAGE = 'bearer/bearer:latest-amd64';

/** The SonarQube server container the Dev Tools card creates and the Security tab scans into. */
export const SONARQUBE_CONTAINER_NAME = 'runova-sonarqube';

export function getSecurityScanner(id: SecurityScannerId): SecurityScannerDescriptor | undefined {
  return SECURITY_SCANNERS.find((scanner) => scanner.id === id);
}

/** Semgrep rulesets offered in the setup dialog. 'auto' is the only one that needs the network. */
export const SEMGREP_RULESETS = [
  { value: 'auto', label: 'Auto (fetches rules from semgrep.dev)' },
  { value: 'p/security-audit', label: 'Security audit' },
  { value: 'p/owasp-top-ten', label: 'OWASP Top 10' },
  { value: 'p/default', label: 'Default' },
];

/**
 * CodeQL languages. The first group needs no build; the compiled ones need a build command, and
 * CodeQL exits 32 ("no code found") without one, which is its single most common failure.
 */
export const CODEQL_LANGUAGES = [
  { value: 'javascript-typescript', label: 'JavaScript / TypeScript', needsBuild: false },
  { value: 'python', label: 'Python', needsBuild: false },
  { value: 'ruby', label: 'Ruby', needsBuild: false },
  { value: 'actions', label: 'GitHub Actions', needsBuild: false },
  { value: 'java-kotlin', label: 'Java / Kotlin', needsBuild: true },
  { value: 'csharp', label: 'C#', needsBuild: true },
  { value: 'go', label: 'Go', needsBuild: true },
  { value: 'c-cpp', label: 'C / C++', needsBuild: true },
  { value: 'swift', label: 'Swift', needsBuild: true },
];

export function codeqlLanguageNeedsBuild(language: string | null): boolean {
  return CODEQL_LANGUAGES.find((l) => l.value === language)?.needsBuild ?? false;
}
