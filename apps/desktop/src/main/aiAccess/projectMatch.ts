/**
 * Which project an agent in another app is working on, from the folder it runs in: the project
 * whose folder holds it, the deepest one when projects are nested. Windows paths compare without
 * regard to case or slash style.
 */

interface FolderProject {
  id: string;
  name: string;
  folderPath: string;
}

function normalize(path: string, platform: NodeJS.Platform): string {
  const forward = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' ? forward.toLowerCase() : forward;
}

export function projectForFolder<P extends FolderProject>(
  projects: readonly P[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): P | null {
  if (!cwd.trim()) return null;
  const here = normalize(cwd, platform);
  let best: { project: P; length: number } | null = null;
  for (const project of projects) {
    if (!project.folderPath) continue;
    const root = normalize(project.folderPath, platform);
    if (!root || (here !== root && !here.startsWith(`${root}/`))) continue;
    if (!best || root.length > best.length) best = { project, length: root.length };
  }
  return best?.project ?? null;
}
