import type { DevOs } from './types.js';

/**
 * Just enough path handling for the clean-up rules, written out here because this package is also
 * bundled into the window, where `node:path` does not exist. Windows and POSIX paths are both
 * handled from any machine, so the rules can be tested on one and used on another.
 *
 * It is not a general path library. `normalize` writes one separator, collapses repeats, resolves
 * `.` and `..`, and drops a trailing separator (except on a root).
 */

export interface PathFlavour {
  sep: '\\' | '/';
  /** What separates the paths in a list such as GOPATH. */
  delimiter: ';' | ':';
  /** A drive path or a network share on Windows, anything starting with a slash elsewhere. */
  isAbsolute(path: string): boolean;
  /** `C:\`, `\\server\share\`, `/`, or `''` for a relative path. */
  rootOf(path: string): string;
  normalize(path: string): string;
  join(base: string, ...parts: string[]): string;
}

function resolveSegments(rest: string, splitter: RegExp, rooted: boolean): string[] {
  const kept: string[] = [];
  for (const segment of rest.split(splitter)) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      kept.push(segment);
    } else if (kept.length > 0 && kept[kept.length - 1] !== '..') {
      kept.pop();
    } else if (!rooted) {
      kept.push('..');
    }
  }
  return kept;
}

const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/;
const DRIVE = /^([A-Za-z]):(?=[\\/])/;

/** The root of a Windows path and how many characters of the path it takes up. */
function winRoot(path: string): { root: string; length: number } {
  const share = UNC.exec(path);
  if (share) return { root: `\\\\${share[1]}\\${share[2]}\\`, length: share[0].length };
  const drive = DRIVE.exec(path);
  if (drive) return { root: `${drive[1]}:\\`, length: 2 };
  if (/^[\\/]/.test(path)) return { root: '\\', length: 1 };
  return { root: '', length: 0 };
}

export const winPath: PathFlavour = {
  sep: '\\',
  delimiter: ';',
  isAbsolute: (path) => /^[A-Za-z]:[\\/]/.test(path) || UNC.test(path),
  rootOf: (path) => winRoot(path).root,
  normalize(path) {
    const { root, length } = winRoot(path);
    const segments = resolveSegments(path.slice(length), /[\\/]+/, root !== '');
    if (segments.length === 0) return root === '' ? '.' : root;
    return root + segments.join('\\');
  },
  join(base, ...parts) {
    return winPath.normalize([base, ...parts].join('\\'));
  },
};

export const posixPath: PathFlavour = {
  sep: '/',
  delimiter: ':',
  isAbsolute: (path) => path.startsWith('/'),
  rootOf: (path) => (path.startsWith('/') ? '/' : ''),
  normalize(path) {
    const root = path.startsWith('/') ? '/' : '';
    const segments = resolveSegments(path, /\/+/, root !== '');
    if (segments.length === 0) return root === '' ? '.' : root;
    return root + segments.join('/');
  },
  join(base, ...parts) {
    return posixPath.normalize([base, ...parts].join('/'));
  },
};

export function pathFlavour(os: DevOs): PathFlavour {
  return os === 'win32' ? winPath : posixPath;
}
