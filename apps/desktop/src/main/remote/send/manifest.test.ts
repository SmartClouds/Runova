import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parseSendMessage, SEND_LIMITS, transferKeyFromId } from '@runova/protocol';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { buildManifest, ManifestError, sendableName, targetFor } from './manifest';

function offerText(files: { transferId: string; path: string; size: number }[]): string {
  return JSON.stringify({ t: 'send-offer', v: 1, batchId: 'b', files });
}

describe('a manifest of picked files and folders', () => {
  it('lists a file by its name and a folder by the paths inside it', async () => {
    const root = tempDir('runova-manifest-');
    writeTree(root, {
      'report.pdf': 'pdf!',
      'Holiday/beach.jpg': 'jpeg',
      'Holiday/raw/day 1/img.cr3': 'raw!!',
    });

    const manifest = await buildManifest([join(root, 'report.pdf'), join(root, 'Holiday')]);

    expect(manifest.files.map((f) => [f.path, f.size])).toEqual([
      ['report.pdf', 4],
      ['Holiday/beach.jpg', 4],
      ['Holiday/raw/day 1/img.cr3', 5],
    ]);
    expect(manifest.files[2].source).toBe(join(root, 'Holiday', 'raw', 'day 1', 'img.cr3'));
    expect(manifest.totalBytes).toBe(13);
    expect(manifest.skipped).toEqual([]);
  });

  it('gives every file an id of its own whose chunk key no other file shares', async () => {
    const root = tempDir('runova-manifest-');
    writeTree(
      root,
      Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`many/f${i}.txt`, 'x'])),
    );

    const manifest = await buildManifest([join(root, 'many')]);

    const keys = new Set(manifest.files.map((f) => transferKeyFromId(f.transferId)));
    expect(keys.size).toBe(300);
    expect(new Set(manifest.files.map((f) => f.transferId)).size).toBe(300);
  });

  it('writes an offer the other side accepts as it is', async () => {
    const root = tempDir('runova-manifest-');
    writeTree(root, { 'Holiday/a b.txt': 'x', 'Holiday/تصویر.png': 'y', 'ok.txt': 'z' });

    const manifest = await buildManifest([join(root, 'Holiday'), join(root, 'ok.txt')]);

    const files = manifest.files.map(({ transferId, path, size }) => ({ transferId, path, size }));
    expect(parseSendMessage(offerText(files))).not.toBeNull();
  });

  it('mends a name other systems would refuse, so the offer is never turned down for it', () => {
    expect(sendableName('a\\b.txt')).toBe('a_b.txt');
    expect(sendableName('tab\there.txt')).toBe('tab_here.txt');
    expect(sendableName('plain.txt')).toBe('plain.txt');
    expect(sendableName('..')).toBe('_');
  });

  it('keeps two picked files of the same name apart', async () => {
    const root = tempDir('runova-manifest-');
    writeTree(root, { 'one/notes.txt': '1', 'two/Notes.txt': '2' });

    const manifest = await buildManifest([
      join(root, 'one', 'notes.txt'),
      join(root, 'two', 'Notes.txt'),
    ]);

    expect(manifest.files.map((f) => f.path)).toEqual(['notes.txt', 'Notes (2).txt']);
  });

  it('skips links and says so, rather than following them out of the folder', async () => {
    const root = tempDir('runova-manifest-');
    const outside = tempDir('runova-outside-');
    writeTree(outside, { 'secret.txt': 'not yours' });
    writeTree(root, { 'shared/kept.txt': 'yes' });
    // A junction needs no special rights on Windows, so this runs everywhere.
    symlinkSync(outside, join(root, 'shared', 'escape'), 'junction');

    const manifest = await buildManifest([join(root, 'shared')]);

    expect(manifest.files.map((f) => f.path)).toEqual(['shared/kept.txt']);
    expect(manifest.skipped).toEqual([
      { path: `shared${sep}escape`, reason: 'Links are not sent.' },
    ]);
  });

  it('skips a file nested deeper than a path may go', async () => {
    const root = tempDir('runova-manifest-');
    const deep = Array.from({ length: SEND_LIMITS.maxSegments }, (_, i) => `d${i}`);
    mkdirSync(join(root, ...deep), { recursive: true });
    writeFileSync(join(root, ...deep, 'too-deep.txt'), 'x');
    writeFileSync(join(root, 'd0', 'fine.txt'), 'x');

    const manifest = await buildManifest([join(root, 'd0')]);

    expect(manifest.files.map((f) => f.path)).toEqual(['d0/fine.txt']);
    expect(manifest.skipped).toHaveLength(1);
    expect(manifest.skipped[0].reason).toMatch(/too deep/i);
  });

  it('turns down a pick with more files than one send carries', async () => {
    const root = tempDir('runova-manifest-');
    writeTree(root, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });

    await expect(buildManifest([root], { maxFiles: 2 })).rejects.toThrow(ManifestError);
    await expect(buildManifest([root], { maxFiles: 2 })).rejects.toMatchObject({
      reason: 'too-many-files',
    });
  });

  it('turns down a pick with nothing to send in it', async () => {
    const root = tempDir('runova-manifest-');
    mkdirSync(join(root, 'empty'));

    await expect(buildManifest([join(root, 'empty')])).rejects.toMatchObject({
      reason: 'nothing-to-send',
    });
  });

  it('turns down a path that is not there', async () => {
    const root = tempDir('runova-manifest-');

    await expect(buildManifest([join(root, 'gone.txt')])).rejects.toMatchObject({
      reason: 'nothing-to-send',
    });
  });
});

describe('where a received file goes', () => {
  it('lands under the save folder, in the folders the path names', () => {
    const root = tempDir('runova-inbox-');

    expect(targetFor(root, 'Holiday/raw/img.cr3')).toEqual({
      dir: join(root, 'Holiday', 'raw'),
      name: 'img.cr3',
    });
    expect(targetFor(root, 'report.pdf')).toEqual({ dir: root, name: 'report.pdf' });
  });

  it('mends names Windows can not hold', () => {
    const root = tempDir('runova-inbox-');

    expect(targetFor(root, 'con/a:b.txt')).toEqual({ dir: join(root, 'con_'), name: 'a_b.txt' });
  });

  it.each(['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/evil.dll', 'a\\..\\b'])(
    'never leaves the save folder for %s',
    (path) => {
      expect(targetFor(tempDir('runova-inbox-'), path)).toBeNull();
    },
  );
});
