import type { Plugin } from 'vite';

const ELECTRON_VITE_SHIM =
  /\n?\/\/ -- CommonJS Shims --\n[\s\S]*?createRequire\(import\.meta\.url\);\n?/;

/**
 * Rewrites the __dirname shim of one bundled file, or returns null when it has none.
 *
 * electron-vite pastes its shim after the last text that looks like an import. A doc comment with
 * an example import counts, so the shim can end up inside that comment and the whole chunk runs
 * without __dirname or require. `import` lines are hoisted, so the top of the file is always safe.
 *
 * The main process's code joins __dirname with paths relative to out/main (`../preload/index.js`,
 * `ptyHost.mjs`). Rolldown moves any of it into out/main/chunks when an entry shares it, so
 * __dirname is the folder of the entries in every file.
 */
export function placeCommonJsShim(code: string, fileName: string): string | null {
  if (!ELECTRON_VITE_SHIM.test(code)) {
    // electron-vite shims every file that mentions __dirname. Without its marker a new version has
    // changed the shim, and this rewrite would be quietly doing nothing.
    if (/\b__dirname\b/.test(code)) {
      throw new Error(`${fileName} uses __dirname but has no CommonJS shim to place.`);
    }
    return null;
  }
  const up = fileName.split('/').slice(1).fill('..').join('/') || '.';
  const shim = [
    '// -- CommonJS Shims --',
    "import __cjs_mod__ from 'node:module';",
    "import __cjs_path__ from 'node:path';",
    'const __filename = import.meta.filename;',
    `const __dirname = __cjs_path__.resolve(import.meta.dirname, '${up}');`,
    'const require = __cjs_mod__.createRequire(import.meta.url);',
    '',
  ].join('\n');
  return shim + code.replace(ELECTRON_VITE_SHIM, '\n');
}

/** Runs after electron-vite's own shim plugin, which is the one it corrects. */
export function commonJsShimPlugin(): Plugin {
  return {
    name: 'runova:common-js-shim',
    apply: 'build',
    enforce: 'post',
    renderChunk: {
      order: 'post',
      handler(code, chunk, { format }) {
        if (format !== 'es') return null;
        const placed = placeCommonJsShim(code, chunk.fileName);
        return placed === null ? null : { code: placed, map: null };
      },
    },
  };
}
