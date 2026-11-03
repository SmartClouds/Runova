import { describe, expect, it } from 'vitest';
import { projectForFolder } from './projectMatch';

/** Which project an agent in another app is working on, from the folder it runs in. */

const projects = [
  { id: 'mono', name: 'Mono', folderPath: 'C:\\code\\mono' },
  { id: 'web', name: 'Web', folderPath: 'C:\\code\\mono\\apps\\web' },
  { id: 'blog', name: 'Blog', folderPath: '/home/sam/blog/' },
];

describe('projectForFolder', () => {
  it('matches the project folder itself and anything inside it', () => {
    expect(projectForFolder(projects, 'C:\\code\\mono', 'win32')?.id).toBe('mono');
    expect(projectForFolder(projects, 'C:\\code\\mono\\packages\\core', 'win32')?.id).toBe('mono');
    expect(projectForFolder(projects, '/home/sam/blog/posts', 'linux')?.id).toBe('blog');
  });

  it('prefers the deepest project when one sits inside another', () => {
    expect(projectForFolder(projects, 'C:\\code\\mono\\apps\\web\\src', 'win32')?.id).toBe('web');
  });

  it('ignores case and slash style on Windows only', () => {
    expect(projectForFolder(projects, 'c:/CODE/Mono/x', 'win32')?.id).toBe('mono');
    expect(projectForFolder(projects, '/home/sam/BLOG', 'linux')).toBeNull();
  });

  it('does not take a sibling folder that only shares the start of the name', () => {
    expect(projectForFolder(projects, 'C:\\code\\mono-old', 'win32')).toBeNull();
    expect(projectForFolder(projects, '', 'win32')).toBeNull();
  });
});
