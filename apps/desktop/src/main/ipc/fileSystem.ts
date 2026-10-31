import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { app, dialog, ipcMain } from 'electron';
import type { DirectoryEntry, ImageFileData } from '../../shared/apiTypes';
import { imageMimeType } from '../../shared/imageFiles';
import { IPC } from '../../shared/ipcChannels';
import { openFiles } from '../fs/openFileWatcher';
import { assertPathWithinRoots } from '../pathGuard';
import { store } from '../store';
import { knownWorktreePaths } from '../worktrees/resolve';

/**
 * Past this an image is left to the default app rather than carried into the renderer as a
 * data URL, which costs about a third again in size on the way over.
 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Every folder the app is allowed to read or write through IPC: its own data, the projects, and
 * their worktrees (which sit next to the repository, outside the project folder, by default).
 */
export async function allowedRoots(): Promise<string[]> {
  const [projects, worktrees] = await Promise.all([store.getProjects(), knownWorktreePaths()]);
  return [app.getPath('userData'), ...projects.map((p) => p.folderPath), ...worktrees];
}

export function registerFileSystemHandlers(): void {
  ipcMain.handle(IPC.fs.readFile, async (_event, path: string): Promise<string> => {
    const safePath = await assertPathWithinRoots(path, await allowedRoots());
    return readFile(safePath, 'utf-8');
  });

  ipcMain.handle(IPC.fs.readImage, async (_event, path: string): Promise<ImageFileData> => {
    const safePath = await assertPathWithinRoots(path, await allowedRoots());
    const mime = imageMimeType(safePath);
    if (!mime) throw new Error('That file is not an image this viewer can show.');
    const info = await stat(safePath);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error('This image is too large to show here. Open it in its default app instead.');
    }
    const bytes = await readFile(safePath);
    return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length };
  });

  ipcMain.handle(IPC.fs.writeFile, async (_event, path: string, content: string): Promise<void> => {
    const safePath = await assertPathWithinRoots(path, await allowedRoots());
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, 'utf-8');
  });

  // An editor tab watches its file, so a change made outside the app (an agent, another editor)
  // reaches it. The push carries the path exactly as the tab sent it.
  ipcMain.handle(IPC.fs.watchFile, async (event, path: string): Promise<void> => {
    const safePath = await assertPathWithinRoots(path, await allowedRoots());
    openFiles.watch(path, safePath, event.sender);
  });

  ipcMain.handle(IPC.fs.unwatchFile, (event, path: string): void => {
    openFiles.unwatch(path, event.sender);
  });

  ipcMain.handle(IPC.fs.listDirectory, async (_event, path: string): Promise<DirectoryEntry[]> => {
    const safePath = await assertPathWithinRoots(path, await allowedRoots());
    const entries = await readdir(safePath, { withFileTypes: true });
    return entries
      .map((entry) => ({
        name: entry.name,
        path: join(safePath, entry.name),
        isDirectory: entry.isDirectory(),
      }))
      .sort(
        (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
      );
  });

  ipcMain.handle(
    IPC.fs.writeScratchFile,
    async (_event, fileName: string, content: string): Promise<string> => {
      const scratchDir = join(app.getPath('userData'), 'scratch');
      await mkdir(scratchDir, { recursive: true });
      const filePath = join(scratchDir, basename(fileName));
      await writeFile(filePath, content, 'utf-8');
      return filePath;
    },
  );

  ipcMain.handle(
    IPC.fs.saveFileAs,
    async (_event, defaultFileName: string, content: string): Promise<string | null> => {
      const result = await dialog.showSaveDialog({ defaultPath: defaultFileName });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, content, 'utf-8');
      return result.filePath;
    },
  );
}
