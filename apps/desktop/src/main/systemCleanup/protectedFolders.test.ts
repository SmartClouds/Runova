import { describe, expect, it } from 'vitest';
import { protectedFolders } from './protectedFolders';

const paths: Record<string, string> = {
  documents: 'C:\\Users\\me\\Documents',
  desktop: 'C:\\Users\\me\\Desktop',
  downloads: 'C:\\Users\\me\\Downloads',
  music: 'C:\\Users\\me\\Music',
  pictures: 'C:\\Users\\me\\Pictures',
  videos: 'C:\\Users\\me\\Videos',
  temp: 'C:\\Users\\me\\AppData\\Local\\Temp',
  userData: 'C:\\Users\\me\\AppData\\Roaming\\Runova',
  appData: 'C:\\Users\\me\\AppData\\Roaming',
};

const getPath = (name: string): string | null => paths[name] ?? null;

describe('protectedFolders', () => {
  it("lists the person's own folders and the app's data", () => {
    const folders = protectedFolders({ os: 'win32', env: {}, getPath });
    for (const name of Object.keys(paths)) expect(folders).toContain(paths[name]);
  });

  it('adds the Windows system folders and any OneDrive folder', () => {
    const folders = protectedFolders({
      os: 'win32',
      env: {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramData: 'C:\\ProgramData',
        OneDrive: 'C:\\Users\\me\\OneDrive',
        OneDriveCommercial: 'D:\\Work\\OneDrive - Contoso',
      },
      getPath,
    });
    expect(folders).toEqual(
      expect.arrayContaining([
        'C:\\Windows',
        'C:\\Program Files',
        'C:\\Program Files (x86)',
        'C:\\ProgramData',
        'C:\\Users\\me\\OneDrive',
        'D:\\Work\\OneDrive - Contoso',
      ]),
    );
  });

  it('knows Windows variable names however they are cased', () => {
    const folders = protectedFolders({
      os: 'win32',
      env: { systemroot: 'C:\\Windows' },
      getPath,
    });
    expect(folders).toContain('C:\\Windows');
  });

  it('leaves out the Windows folders on other systems', () => {
    const folders = protectedFolders({
      os: 'linux',
      env: { SystemRoot: 'C:\\Windows' },
      getPath: (name) => (name === 'documents' ? '/home/me/Documents' : null),
    });
    expect(folders).toEqual(['/home/me/Documents']);
  });

  it('skips a folder the system cannot name, and one that throws', () => {
    const folders = protectedFolders({
      os: 'win32',
      env: {},
      getPath: (name) => {
        if (name === 'music') throw new Error('unknown name');
        return name === 'documents' ? (paths.documents ?? null) : null;
      },
    });
    expect(folders).toEqual([paths.documents]);
  });

  it('lists each folder once, and only full paths', () => {
    const folders = protectedFolders({
      os: 'win32',
      env: { OneDrive: 'relative\\OneDrive', SystemRoot: 'C:\\Windows' },
      getPath: () => 'C:\\Users\\me\\Documents',
    });
    expect(folders).toEqual(['C:\\Users\\me\\Documents', 'C:\\Windows']);
  });
});
