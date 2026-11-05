import { describe, expect, it } from 'vitest';
import { assessDeleteTarget, assessRoot, type SafetyContext } from './safety.js';

const win: SafetyContext = {
  os: 'win32',
  home: 'C:\\Users\\me',
  protectedFolders: [
    'C:\\Users\\me\\Documents',
    'C:\\Users\\me\\Desktop',
    'C:\\Users\\me\\Downloads',
    'C:\\Users\\me\\AppData\\Roaming\\Runova',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ],
  projectFolders: ['C:\\dev\\app', 'D:\\work'],
};

const linux: SafetyContext = {
  os: 'linux',
  home: '/home/me',
  protectedFolders: ['/home/me/Documents', '/home/me/Downloads'],
  projectFolders: ['/srv/app'],
};

const mac: SafetyContext = {
  os: 'darwin',
  home: '/Users/me',
  protectedFolders: ['/Users/me/Documents'],
  projectFolders: [],
};

function refused(verdict: { ok: boolean; reason?: string }): string {
  expect(verdict.ok).toBe(false);
  return verdict.reason ?? '';
}

describe('assessRoot on Windows', () => {
  it.each([
    'C:\\Users\\me\\.nuget\\packages',
    'C:\\Users\\me\\AppData\\Local\\ms-playwright',
    'D:\\caches\\nuget',
    'C:/Users/me/.nuget/packages',
    'C:\\Users\\me\\.nuget\\packages\\',
  ])('accepts the cache folder %s', (root) => {
    expect(assessRoot(root, win)).toEqual({ ok: true });
  });

  it.each([
    ['a relative path', '.nuget\\packages'],
    ['a drive', 'C:\\'],
    ['another drive', 'D:\\'],
    ['a drive written with a slash', 'C:/'],
    ['the home folder', 'C:\\Users\\me'],
    ['a folder above the home folder', 'C:\\Users'],
    ['Documents', 'C:\\Users\\me\\Documents'],
    ['a folder inside Documents', 'C:\\Users\\me\\Documents\\cache'],
    ['Downloads', 'C:\\Users\\me\\Downloads'],
    ["the app's own data", 'C:\\Users\\me\\AppData\\Roaming\\Runova'],
    ['a folder inside the app data', 'C:\\Users\\me\\AppData\\Roaming\\Runova\\cache'],
    ['the Windows folder', 'C:\\Windows'],
    ['a folder inside Windows', 'C:\\Windows\\Temp'],
    ['Program Files', 'C:\\Program Files'],
    ['a folder inside Program Files', 'C:\\Program Files\\Something\\cache'],
    ['a network path', '\\\\server\\share\\cache'],
    ['a device path', '\\\\?\\C:\\x\\cache'],
    ['a path that climbs out with ..', 'C:\\Users\\me\\..\\other\\cache'],
    ['the SSH keys folder', 'C:\\Users\\me\\.ssh'],
    ['a folder inside the SSH keys', 'C:\\Users\\me\\.ssh\\cache'],
    ['the AWS credentials folder', 'C:\\Users\\me\\.aws'],
    ['a folder that holds a project', 'C:\\dev'],
    ['a project itself', 'C:\\dev\\app'],
    ['a folder inside a project', 'C:\\dev\\app\\node_modules\\.cache'],
    ['a drive that holds a project', 'D:\\'],
  ])('refuses %s', (_what, root) => {
    expect(refused(assessRoot(root, win)).length).toBeGreaterThan(0);
  });

  it('ignores letter case, as Windows does', () => {
    refused(assessRoot('c:\\users\\ME\\documents\\cache', win));
    refused(assessRoot('C:\\WINDOWS\\temp', win));
    refused(assessRoot('c:\\USERS\\me', win));
  });

  it('does not take a folder that merely starts with the same letters for one inside', () => {
    expect(assessRoot('C:\\Users\\me\\Documents2\\cache', win)).toEqual({ ok: true });
    expect(assessRoot('C:\\Windows.old2\\x', win)).toEqual({ ok: true });
  });

  it('says why, in words', () => {
    expect(refused(assessRoot('C:\\', win))).toMatch(/drive/i);
    expect(refused(assessRoot('C:\\Users\\me', win))).toMatch(/home/i);
    expect(refused(assessRoot('C:\\Users\\me\\Documents\\x', win))).toMatch(/protected/i);
    expect(refused(assessRoot('C:\\dev\\app\\x', win))).toMatch(/project/i);
    expect(refused(assessRoot('\\\\server\\share', win))).toMatch(/network|device/i);
    expect(refused(assessRoot('relative', win))).toMatch(/absolute|full path/i);
  });
});

describe('assessRoot on Linux and macOS', () => {
  it.each(['/home/me/.bun/install/cache', '/home/me/.cache/ms-playwright', '/opt/caches/nuget'])(
    'accepts %s',
    (root) => {
      expect(assessRoot(root, linux)).toEqual({ ok: true });
    },
  );

  it.each([
    '/',
    '/home',
    '/home/me',
    '/home/me/Documents',
    '/home/me/Documents/cache',
    '/home/me/.ssh',
    '/usr',
    '/usr/local/cache',
    '/etc/cache',
    '/bin',
    '/boot/x',
    '/proc/1',
    '/srv',
    '/srv/app/cache',
    'relative/cache',
  ])('refuses %s', (root) => {
    refused(assessRoot(root, linux));
  });

  it('tells folders that differ only by case apart on Linux', () => {
    expect(assessRoot('/home/me/documents/cache', linux)).toEqual({ ok: true });
  });

  it('does not tell them apart on macOS, whose disk ignores case', () => {
    refused(assessRoot('/users/ME/documents/cache', mac));
    refused(assessRoot('/system/library/x', mac));
    refused(assessRoot('/Library/Application Support/x', mac));
    expect(assessRoot('/Users/me/Library/Caches/ms-playwright', mac)).toEqual({ ok: true });
  });
});

describe('assessDeleteTarget', () => {
  const root = 'C:\\Users\\me\\.nuget\\packages';

  it('accepts something inside the cache', () => {
    expect(assessDeleteTarget(`${root}\\acornima\\1.0.0`, root, win)).toEqual({ ok: true });
    expect(assessDeleteTarget(`${root}/acornima/1.0.0`, root, win)).toEqual({ ok: true });
    expect(assessDeleteTarget(`${root.toUpperCase()}\\ACORNIMA`, root, win)).toEqual({ ok: true });
  });

  it('refuses the cache folder itself, because only what is inside it is ever removed', () => {
    expect(refused(assessDeleteTarget(root, root, win))).toMatch(/cache folder itself/i);
    expect(refused(assessDeleteTarget(`${root}\\`, root, win))).toMatch(/cache folder itself/i);
  });

  it.each([
    ['outside the cache', 'C:\\Users\\me\\.nuget'],
    ['a sibling', 'C:\\Users\\me\\.nuget\\other\\1.0.0'],
    ['a sibling that starts with the same letters', `${root}2\\acornima`],
    ['the parent', 'C:\\Users\\me'],
    ['a path that climbs back out', `${root}\\acornima\\..\\..\\..`],
    ['a relative path', 'acornima\\1.0.0'],
    ['a network path', '\\\\server\\share\\packages\\acornima'],
  ])('refuses %s', (_what, target) => {
    refused(assessDeleteTarget(target, root, win));
  });

  it('refuses everything when the cache folder itself is not acceptable', () => {
    const reason = refused(
      assessDeleteTarget(
        'C:\\Users\\me\\Documents\\cache\\x',
        'C:\\Users\\me\\Documents\\cache',
        win,
      ),
    );
    expect(reason).toMatch(/protected/i);
    refused(assessDeleteTarget('/etc/x/y', '/etc/x', linux));
  });

  it('works the same way on Linux, and respects case there', () => {
    const base = '/home/me/.bun/install/cache';
    expect(assessDeleteTarget(`${base}/react@19.2.8@@@1`, base, linux)).toEqual({ ok: true });
    refused(assessDeleteTarget(`${base.toUpperCase()}/react`, base, linux));
    refused(assessDeleteTarget(base, base, linux));
  });
});
