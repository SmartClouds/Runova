import { basename } from 'node:path';
import { z } from 'zod';
import type {
  PackageInfo,
  PackageManagerSection,
  PackageUpdateRequest,
} from '../../../shared/apiTypes';
import { listProjectPackages, updateProjectPackages } from '../../ipc/packageManagers';
import { defineTool, type ToolContext } from '../registry';
import { plural, projectIdArg, projectIdOf } from './shared';

/**
 * Package tools: a project's dependencies and what is out of date, as the Packages tab shows
 * them, and updating packages the way its Update button does. Updating runs the package manager
 * in the project folder (and its install scripts), so it is sensitive.
 */

/** A scan asks each registry for the latest versions, so an update reuses a recent one. */
const SCAN_REUSE_MS = 2 * 60_000;
const recentScans = new Map<string, { at: number; sections: PackageManagerSection[] }>();

async function scan(projectId: string): Promise<PackageManagerSection[]> {
  const { sections } = await listProjectPackages(projectId);
  recentScans.set(projectId, { at: Date.now(), sections });
  return sections;
}

async function recentScan(projectId: string): Promise<PackageManagerSection[]> {
  const cached = recentScans.get(projectId);
  if (cached && Date.now() - cached.at < SCAN_REUSE_MS) return cached.sections;
  return scan(projectId);
}

function packageShape(info: PackageInfo) {
  return {
    name: info.name,
    current: info.currentVersion,
    latest: info.latestVersion,
    outdated: info.isOutdated,
    dev: info.isDev,
    installed: info.isInstalled,
    project: info.projectLabel,
  };
}

const packageArg = z.object({
  name: z.string().min(1).describe('The package name, like react or Newtonsoft.Json.'),
  version: z
    .string()
    .min(1)
    .optional()
    .describe('The version to move to. Leave it out for the latest one.'),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Only in this sub-project, by the project label packages_list shows. Leave it out to update the package everywhere the project uses it.',
    ),
});
type PackageArg = z.infer<typeof packageArg>;

interface PlannedUpdate {
  request: PackageUpdateRequest;
  label: string;
  from: string;
}

/** Turns what the agent asked for into the requests the Packages tab would send. */
async function plan(context: ToolContext, wanted: PackageArg[]): Promise<PlannedUpdate[]> {
  const sections = await recentScan(projectIdOf(context));
  const planned: PlannedUpdate[] = [];
  for (const one of wanted) {
    const project = one.project?.trim().toLowerCase();
    const matches = sections.flatMap((section) =>
      section.packages
        .filter(
          (info) =>
            info.name === one.name &&
            (!project || info.projectLabel.trim().toLowerCase() === project),
        )
        .map((info) => ({ section, info })),
    );
    if (matches.length === 0) {
      throw new Error(
        `This project has no package named ${one.name}${one.project ? ` in ${one.project}` : ''}. packages_list shows what it has.`,
      );
    }
    for (const { section, info } of matches) {
      const targetVersion = one.version ?? info.latestVersion;
      if (!targetVersion) {
        throw new Error(
          `The latest version of ${one.name} could not be looked up. Pass the version to move to.`,
        );
      }
      planned.push({
        request: {
          ecosystem: section.ecosystem,
          name: info.name,
          targetVersion,
          manifestPath: info.manifestPath,
        },
        label: `${info.name} (${info.projectLabel})`,
        from: info.currentVersion,
      });
    }
  }
  return planned;
}

export const packageTools = [
  defineTool({
    name: 'packages_list',
    area: 'packages',
    title: 'List packages',
    description:
      "The project's dependencies for each package manager it uses (npm, pnpm, yarn, bun, NuGet, pub): installed and latest version, whether it is out of date, and which sub-project it belongs to.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Read the project packages' }),
    async run(_args, context) {
      const sections = await scan(projectIdOf(context));
      return {
        data: sections.map((section) => ({
          ecosystem: section.ecosystem,
          manager: section.manager,
          status: section.status,
          message: section.message,
          packages: section.packages.map(packageShape),
          runtimes: section.runtimes.map((runtime) => ({
            kind: runtime.kind,
            declared: runtime.declared,
            latest: runtime.latestVersion,
            outdated: runtime.isOutdated,
            file: basename(runtime.manifestPath),
            project: runtime.projectLabel,
          })),
        })),
      };
    },
  }),

  defineTool({
    name: 'packages_outdated',
    area: 'packages',
    title: 'Outdated packages',
    description:
      'Only the packages and runtime versions (Node, .NET, Dart, Flutter and so on) that have a newer release, with the version each could move to.',
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Check which packages are out of date' }),
    async run(_args, context) {
      const sections = await scan(projectIdOf(context));
      return {
        data: {
          packages: sections.flatMap((section) =>
            section.packages
              .filter((info) => info.isOutdated)
              .map((info) => ({ manager: section.manager, ...packageShape(info) })),
          ),
          runtimes: sections.flatMap((section) =>
            section.runtimes
              .filter((runtime) => runtime.isOutdated)
              .map((runtime) => ({
                kind: runtime.kind,
                declared: runtime.declared,
                current: runtime.currentVersion,
                latest: runtime.latestVersion,
                file: basename(runtime.manifestPath),
                project: runtime.projectLabel,
              })),
          ),
          notChecked: sections
            .filter((section) => section.status !== 'ok')
            .map((section) => ({ manager: section.manager, message: section.message })),
        },
      };
    },
  }),

  defineTool({
    name: 'packages_update',
    area: 'packages',
    title: 'Update packages',
    description:
      'Updates packages to the latest version, or to the version given, with the package manager the project uses. A package in several sub-projects is updated in each unless project is given.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, packages: z.array(packageArg).min(1).max(50) }),
    async preview(args, context) {
      const planned = await plan(context, args.packages);
      return {
        title: `Update ${plural(planned.length, 'package')}`,
        summary: 'Runs the package manager in the project folder, with its install scripts.',
        fields: planned.map((one) => ({
          label: one.label,
          value: `${one.from} to ${one.request.targetVersion}`,
          mono: true,
        })),
      };
    },
    async run(args, context) {
      const projectId = projectIdOf(context);
      const planned = await plan(context, args.packages);
      recentScans.delete(projectId);
      const result = await updateProjectPackages(
        projectId,
        planned.map((one) => one.request),
      );
      const done = result.results.filter((one) => one.ok).map((one) => one.name);
      if (!result.ok) {
        const failed = result.results
          .filter((one) => !one.ok)
          .map((one) => `${one.name}: ${one.message}`)
          .join('\n');
        const prefix = done.length > 0 ? `Updated ${done.join(', ')}, but not the rest.\n` : '';
        throw new Error(`${prefix}${failed}`);
      }
      return { text: `Updated ${plural(done.length, 'package')}: ${done.join(', ')}.` };
    },
  }),
];
