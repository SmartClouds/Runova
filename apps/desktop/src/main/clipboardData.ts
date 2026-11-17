import { clipboard } from 'electron';

/**
 * Reads the clipboard the way Electron 45 hands it out: a list of items, each holding its data
 * per MIME type. A platform format with no MIME name of its own (Finder's
 * `NSFilenamesPboardType`, for one) is listed under Electron's raw-format type, which
 * `rawFormat` spells out.
 */

export function rawFormat(format: string): string {
  return `electron application/osclipboard;format="${format}"`;
}

export interface ClipboardData {
  /** The type the data was found under, one of those asked for. */
  type: string;
  bytes: Buffer;
}

/**
 * The clipboard's data in the first of `types` it holds, in the order they are given, or null
 * when it holds none of them.
 */
export async function readClipboardData(types: readonly string[]): Promise<ClipboardData | null> {
  const items = await clipboard.read();
  for (const type of types) {
    for (const item of items) {
      if (!item.types.includes(type)) continue;
      const data = await item.getType(type);
      // Only a bookmark comes back as something other than a Blob.
      if ('arrayBuffer' in data) return { type, bytes: Buffer.from(await data.arrayBuffer()) };
    }
  }
  return null;
}
