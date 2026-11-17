import { fileURLToPath } from 'node:url';
import { rawFormat, readClipboardData } from './clipboardData';

/**
 * The files currently copied on this computer, the way Explorer, Finder and a Linux file manager
 * each put them on the clipboard. Shared by the RDP clipboard sync and the workspace explorer's
 * paste-from-OS feature.
 *
 * Electron lists a file copy as `text/uri-list` on every platform (from Explorer's drop list,
 * Finder's file URLs and the file manager's own list), one percent-encoded `file://` URL per
 * line. The platform's own formats are kept as fallbacks for a copy that only carries those.
 */

const URI_LIST = 'text/uri-list';
const MAC_PLIST = rawFormat('NSFilenamesPboardType');
const MAC_FILE_URL = rawFormat('public.file-url');
const GNOME_FILES = 'x-special/gnome-copied-files';

/** The formats that can name copied files on this platform, best first. */
function fileFormats(): string[] {
  if (process.platform === 'darwin') return [URI_LIST, MAC_PLIST, MAC_FILE_URL];
  if (process.platform === 'linux') return [URI_LIST, GNOME_FILES, rawFormat(GNOME_FILES)];
  return [URI_LIST];
}

export interface CopiedFiles {
  /** The clipboard format the list was read from. */
  format: string;
  /** The list as that format writes it. */
  text: string;
}

/** The raw list of the files copied right now, or null when the clipboard holds no files. */
export async function copiedFiles(): Promise<CopiedFiles | null> {
  try {
    const data = await readClipboardData(fileFormats());
    const text = data?.bytes.toString('utf8').replace(/\0+$/, '').trim();
    return data && text ? { format: data.type, text } : null;
  } catch {
    return null;
  }
}

function plistPaths(plist: string): string[] {
  return [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map((match) =>
    match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'),
  );
}

/** The absolute paths a copied-files list names, top-level only. */
export function copiedPaths({ format, text }: CopiedFiles): string[] {
  if (format === MAC_PLIST) return plistPaths(text);
  const windows = process.platform === 'win32';
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('file://'))
    .map((line) => fileURLToPath(line, { windows }));
}

/** The absolute paths of whatever is copied on the OS clipboard right now, top-level only. */
export async function osClipboardPaths(): Promise<string[]> {
  const copied = await copiedFiles();
  return copied ? copiedPaths(copied) : [];
}
