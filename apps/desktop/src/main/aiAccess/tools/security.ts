import {
  getSecurityScanner,
  SECURITY_SCANNERS,
  SECURITY_SEVERITIES,
  SECURITY_VERDICT_LABEL,
  type SecurityScannerId,
  type SecurityScanRecord,
} from '@runova/core';
import { z } from 'zod';
import { securityPreflight, startSecurityScan } from '../../ipc/security';
import { cancelSecurityScan, getActiveScan, newScanRunId } from '../../security/scanRunner';
import { securityScanDb } from '../../securityScanDb';
import { defineTool, type ToolContext } from '../registry';
import { plural, projectIdArg, projectIdOf, projectOf } from './shared';

/**
 * Security scan tools: the report the Security tab shows, which scanners can run, and starting or
 * cancelling a scan. A scan goes through the same runner as the tab's Scan button and is saved to
 * the same history, so the tab shows what an agent started.
 */

const scannerIds = SECURITY_SCANNERS.map((scanner) => scanner.id) as [
  SecurityScannerId,
  ...SecurityScannerId[],
];

const MAX_FINDINGS = 500;

function scannerName(id: SecurityScannerId): string {
  return getSecurityScanner(id)?.name ?? id;
}

/** The report without the scanners' raw output, with findings at or above a severity. */
function reportShape(record: SecurityScanRecord, minSeverity: string, limit: number) {
  const allowed = SECURITY_SEVERITIES.slice(
    0,
    SECURITY_SEVERITIES.indexOf(minSeverity as never) + 1,
  );
  const findings = record.findings.filter((finding) => allowed.includes(finding.severity));
  return {
    id: record.id,
    createdAt: record.createdAt,
    status: record.status,
    verdict: record.verdict,
    verdictLabel: SECURITY_VERDICT_LABEL[record.verdict],
    score: record.score,
    counts: record.counts,
    durationMs: record.durationMs,
    scanners: record.runs.map((one) => ({
      scanner: one.scannerId,
      status: one.status,
      toolVersion: one.toolVersion,
      findingCount: one.findingCount,
      truncated: one.truncated,
      error: one.error,
      warnings: one.warnings,
    })),
    findingsShown: Math.min(findings.length, limit),
    findingsMatching: findings.length,
    findings: findings.slice(0, limit).map((finding) => ({
      id: finding.id,
      scanner: finding.scannerId,
      severity: finding.severity,
      kind: finding.kind,
      ruleId: finding.ruleId,
      title: finding.title,
      detail: finding.detail,
      file: finding.file,
      line: finding.line,
      endLine: finding.endLine,
      excerpt: finding.excerpt,
      cwe: finding.cwe,
      cve: finding.cve,
      packageName: finding.packageName,
      installedVersion: finding.installedVersion,
      fixedVersion: finding.fixedVersion,
      remediation: finding.remediation,
      helpUri: finding.helpUri,
    })),
  };
}

function runningShape(projectId: string) {
  const active = getActiveScan(projectId);
  if (!active) return null;
  return {
    runId: active.runId,
    startedAt: new Date(active.startedAt).toISOString(),
    scanners: active.scannerIds,
    completedScanners: active.completedScanners,
    totalScanners: active.totalScanners,
    progress: active.scanners.map((one) => ({
      scanner: one.scannerId,
      phase: one.phase,
      message: one.message,
    })),
  };
}

/** The scanners a scan would use: the ones asked for, or the ready free ones the tab preselects. */
async function pickScanners(
  asked: SecurityScannerId[] | undefined,
  context: ToolContext,
): Promise<SecurityScannerId[]> {
  const preflight = await securityPreflight(projectIdOf(context));
  const ready = (id: SecurityScannerId) => preflight.some((p) => p.scannerId === id && p.ready);
  if (asked && asked.length > 0) {
    const notReady = asked.filter((id) => !ready(id));
    if (notReady.length > 0) {
      throw new Error(
        `${notReady.map(scannerName).join(', ')} ${notReady.length === 1 ? 'is' : 'are'} not ready. security_scanners says what each one needs.`,
      );
    }
    return [...new Set(asked)];
  }
  const picked = SECURITY_SCANNERS.filter((scanner) => !scanner.costsMoney && ready(scanner.id));
  if (picked.length === 0) {
    throw new Error(
      'No security scanner is ready. Install Semgrep, Trivy or another scanner from the Agent Tools page first.',
    );
  }
  return picked.map((scanner) => scanner.id);
}

export const securityTools = [
  defineTool({
    name: 'security_report',
    area: 'security',
    title: 'Security scan report',
    description:
      "The project's latest security scan as the Security tab shows it: verdict, score, counts per severity, how each scanner did and the findings with file, line and fix advice. Also says whether a scan is running now and lists earlier scans; pass scanId to read one of those.",
    risk: 'read',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      scanId: z.string().min(1).optional().describe('An earlier scan from the history list.'),
      minSeverity: z
        .enum(SECURITY_SEVERITIES as [string, ...string[]])
        .default('low')
        .describe('Leave out findings below this severity. Info findings are hidden by default.'),
      limit: z.number().int().min(1).max(MAX_FINDINGS).default(100),
    }),
    preview: (args) => ({
      title: args.scanId ? `Read security scan ${args.scanId}` : 'Read the security scan report',
    }),
    async run(args, context) {
      const projectId = projectIdOf(context);
      const record = args.scanId
        ? securityScanDb.get(args.scanId)
        : securityScanDb.latest(projectId);
      if (args.scanId && record?.projectId !== projectId) {
        throw new Error(`This project has no scan with the id ${args.scanId}.`);
      }
      return {
        data: {
          running: runningShape(projectId),
          report: record ? reportShape(record, args.minSeverity, args.limit) : null,
          history: securityScanDb.list(projectId).map((one) => ({
            id: one.id,
            createdAt: one.createdAt,
            status: one.status,
            verdict: one.verdict,
            score: one.score,
            counts: one.counts,
          })),
        },
      };
    },
  }),

  defineTool({
    name: 'security_scanners',
    area: 'security',
    title: 'Security scanners',
    description:
      'The security scanners Runova can run on the project, whether each is ready, what an unready one still needs, and which ones cost money.',
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Check which security scanners are ready' }),
    async run(_args, context) {
      const preflight = await securityPreflight(projectIdOf(context));
      return {
        data: SECURITY_SCANNERS.map((scanner) => {
          const check = preflight.find((p) => p.scannerId === scanner.id);
          return {
            id: scanner.id,
            name: scanner.name,
            covers: scanner.covers,
            estimate: scanner.estimate,
            costsMoney: scanner.costsMoney === true,
            ready: check?.ready ?? false,
            needs: (check?.requirements ?? [])
              .filter((requirement) => requirement.status !== 'ok' && requirement.blocking)
              .map((requirement) => requirement.remedy),
          };
        }),
      };
    },
  }),

  defineTool({
    name: 'security_run_scan',
    area: 'security',
    title: 'Run a security scan',
    description:
      'Starts a security scan and returns at once, since a scan takes minutes and CodeQL or Strix can take an hour. Leave scannerIds out to use every ready scanner that costs nothing, as the Security tab does. Call security_report later to follow it and read the result.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      scannerIds: z.array(z.enum(scannerIds)).max(scannerIds.length).optional(),
    }),
    async preview(args, context) {
      const project = await projectOf(context);
      const asked = args.scannerIds ?? [];
      const paid = asked.filter((id) => getSecurityScanner(id)?.costsMoney);
      return {
        title: `Run a security scan on ${project.name}`,
        fields: [
          {
            label: 'Scanners',
            value:
              asked.length > 0 ? asked.map(scannerName).join(', ') : 'Every ready free scanner',
          },
          ...(paid.length > 0
            ? [
                {
                  label: 'Cost',
                  value: `${paid.map(scannerName).join(' and ')} runs your code in a sandbox and spends tokens against your own API key. It can take up to an hour.`,
                },
              ]
            : []),
        ],
      };
    },
    async run(args, context) {
      const projectId = projectIdOf(context);
      if (getActiveScan(projectId)) {
        throw new Error('A security scan is already running on this project. See security_report.');
      }
      const picked = await pickScanners(args.scannerIds, context);
      const runId = newScanRunId();
      // The runner saves the record to history when it ends, so nothing waits on it here.
      void startSecurityScan(projectId, { scannerIds: picked }, runId).catch(() => {
        // Scanner failures end up in the saved record. Only a broken run gets here, and then
        // security_report simply stops listing it as running.
      });
      return {
        text: `Started a security scan with ${plural(picked.length, 'scanner')} (${picked.map(scannerName).join(', ')}). Call security_report to follow it; the report replaces the old one when the scan ends.`,
      };
    },
  }),

  defineTool({
    name: 'security_cancel_scan',
    area: 'security',
    title: 'Cancel a security scan',
    description:
      'Cancels the security scan running on the project. Findings the finished scanners already have are kept.',
    risk: 'write',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Cancel the running security scan' }),
    async run(_args, context) {
      const active = getActiveScan(projectIdOf(context));
      if (!active) throw new Error('No security scan is running on this project.');
      cancelSecurityScan(active.runId);
      return { text: 'Cancelled the security scan.' };
    },
  }),
];
