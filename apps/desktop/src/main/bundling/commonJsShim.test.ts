import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { placeCommonJsShim } from './commonJsShim';

/** electron-vite's shim, where it pastes it when a doc comment has an example import. */
const SHIM_IN_A_COMMENT = `import { join } from "node:path";
/**
 * \`\`\`ts
 * import { _SHA1 } from '@noble/hashes/legacy.js';

// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
 * const hash = new _SHA1();
 * \`\`\`
 */
console.log(join(__dirname, 'ptyHost.mjs'), typeof require, typeof __filename);
`;

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Runs a placed file for real, at its place under a pretend out/main, and returns what it logs. */
function run(code: string, fileName: string): { main: string; output: string } {
  const main = mkdtempSync(join(tmpdir(), 'runova-shim-'));
  folders.push(main);
  const file = join(main, fileName);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, code);
  return { main, output: execFileSync(process.execPath, [file], { encoding: 'utf-8' }).trim() };
}

describe('the CommonJS shim of the main bundle', () => {
  it('gets out of a doc comment, so the chunk has __dirname and require', () => {
    const placed = placeCommonJsShim(SHIM_IN_A_COMMENT, 'chunks/live-abc.mjs') ?? '';

    expect(placed.startsWith('// -- CommonJS Shims --')).toBe(true);
    expect(placed.match(/CommonJS Shims/g)).toHaveLength(1);
    expect(placed).toContain("import { _SHA1 } from '@noble/hashes/legacy.js';");
  });

  it('points a chunk at the folder of the entries', () => {
    const placed = placeCommonJsShim(SHIM_IN_A_COMMENT, 'chunks/live-abc.mjs') ?? '';

    const { main, output } = run(placed, 'chunks/live-abc.mjs');

    expect(output).toBe(`${join(main, 'ptyHost.mjs')} function string`);
  });

  it('leaves an entry at its own folder', () => {
    const placed = placeCommonJsShim(SHIM_IN_A_COMMENT, 'index.mjs') ?? '';

    const { main, output } = run(placed, 'index.mjs');

    expect(output).toBe(`${join(main, 'ptyHost.mjs')} function string`);
  });

  it('leaves a file alone that needs no shim', () => {
    expect(placeCommonJsShim('export const one = 1;\n', 'chunks/one.mjs')).toBeNull();
  });

  it('fails the build when a file uses __dirname and the shim is not there', () => {
    expect(() => placeCommonJsShim('console.log(__dirname);\n', 'chunks/live.mjs')).toThrow(
      'chunks/live.mjs uses __dirname but has no CommonJS shim to place.',
    );
  });
});
