import { describe, expect, it } from 'vitest';
import { pathFlavour, posixPath, winPath } from './paths.js';

describe('winPath', () => {
  it('writes backslashes, collapses repeats and drops a trailing separator', () => {
    expect(winPath.normalize('D:/caches/nuget/')).toBe('D:\\caches\\nuget');
    expect(winPath.normalize('C:\\a\\\\b')).toBe('C:\\a\\b');
    expect(winPath.normalize('C:\\a\\b\\')).toBe('C:\\a\\b');
  });

  it('resolves . and .. segments', () => {
    expect(winPath.normalize('C:\\Users\\me\\..\\other')).toBe('C:\\Users\\other');
    expect(winPath.normalize('C:\\a\\.\\b')).toBe('C:\\a\\b');
    expect(winPath.normalize('C:\\..\\x')).toBe('C:\\x');
  });

  it('keeps a drive root as it is', () => {
    expect(winPath.normalize('C:\\')).toBe('C:\\');
    expect(winPath.normalize('C:/')).toBe('C:\\');
    expect(winPath.rootOf('c:/users')).toBe('c:\\');
  });

  it('knows a network path and its share', () => {
    expect(winPath.normalize('\\\\server\\share\\x\\')).toBe('\\\\server\\share\\x');
    expect(winPath.rootOf('\\\\server\\share\\x')).toBe('\\\\server\\share\\');
    expect(winPath.rootOf('//server/share/x')).toBe('\\\\server\\share\\');
  });

  it('calls a path absolute only when it names a drive or a share', () => {
    expect(winPath.isAbsolute('C:\\x')).toBe(true);
    expect(winPath.isAbsolute('C:/x')).toBe(true);
    expect(winPath.isAbsolute('\\\\server\\share')).toBe(true);
    expect(winPath.isAbsolute('C:')).toBe(false);
    expect(winPath.isAbsolute('C:x')).toBe(false);
    expect(winPath.isAbsolute('\\x')).toBe(false);
    expect(winPath.isAbsolute('x\\y')).toBe(false);
    expect(winPath.isAbsolute('')).toBe(false);
  });

  it('joins and normalises', () => {
    expect(winPath.join('C:\\a', 'b', 'c')).toBe('C:\\a\\b\\c');
    expect(winPath.join('C:\\a\\', 'b/c')).toBe('C:\\a\\b\\c');
  });

  it('separates paths in a list with a semicolon', () => {
    expect(winPath.delimiter).toBe(';');
    expect(winPath.sep).toBe('\\');
  });
});

describe('posixPath', () => {
  it('collapses repeats, resolves dots and drops a trailing slash', () => {
    expect(posixPath.normalize('/a//b/./c/../d/')).toBe('/a/b/d');
    expect(posixPath.normalize('/')).toBe('/');
    expect(posixPath.normalize('/../x')).toBe('/x');
  });

  it('has the one root', () => {
    expect(posixPath.rootOf('/home/me')).toBe('/');
    expect(posixPath.rootOf('home/me')).toBe('');
  });

  it('calls a path absolute when it starts with a slash', () => {
    expect(posixPath.isAbsolute('/x')).toBe(true);
    expect(posixPath.isAbsolute('x')).toBe(false);
    expect(posixPath.isAbsolute('')).toBe(false);
  });

  it('keeps a relative path relative', () => {
    expect(posixPath.normalize('a/b/../c')).toBe('a/c');
    expect(posixPath.normalize('../a')).toBe('../a');
  });

  it('joins', () => {
    expect(posixPath.join('/a', 'b/c')).toBe('/a/b/c');
    expect(posixPath.join('/a/', 'b')).toBe('/a/b');
  });

  it('treats a backslash as part of a name', () => {
    expect(posixPath.normalize('/a\\b')).toBe('/a\\b');
  });

  it('separates paths in a list with a colon', () => {
    expect(posixPath.delimiter).toBe(':');
    expect(posixPath.sep).toBe('/');
  });
});

describe('pathFlavour', () => {
  it('picks the one for the system', () => {
    expect(pathFlavour('win32')).toBe(winPath);
    expect(pathFlavour('linux')).toBe(posixPath);
    expect(pathFlavour('darwin')).toBe(posixPath);
  });
});
