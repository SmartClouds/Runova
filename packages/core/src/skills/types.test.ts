import { describe, expect, it } from 'vitest';
import { isSafeRelativeSkillPath, isSafeSkillId, parseRepositoryIndex } from './types.js';

/**
 * A repository index comes from whoever publishes the repository. Its skill id and file paths
 * are joined onto the user's skills folder on install, so the schema refuses anything that could
 * climb out of that folder or point somewhere absolute.
 */

function index(skill: { id?: string; files?: { path: string; url: string }[] }) {
  return {
    name: 'Repo',
    skills: [
      {
        id: skill.id ?? 'demo',
        name: 'Demo',
        description: 'd',
        category: 'c',
        author: 'a',
        version: '1',
        files: skill.files ?? [{ path: 'SKILL.md', url: 'demo/SKILL.md' }],
      },
    ],
  };
}

describe('skill id', () => {
  it('accepts a plain folder name', () => {
    expect(isSafeSkillId('code-review_2.1')).toBe(true);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', '../x', 'x/../../..', 'C:', 'has space'])(
    'refuses %j',
    (id) => {
      expect(isSafeSkillId(id)).toBe(false);
    },
  );
});

describe('skill file path', () => {
  it.each(['SKILL.md', 'docs/guide.md', './SKILL.md', 'a\\b.md'])('accepts %j', (path) => {
    expect(isSafeRelativeSkillPath(path)).toBe(true);
  });

  it.each([
    '',
    '../settings.json',
    'docs/../../x',
    '..\\x',
    '/etc/passwd',
    '\\\\server\\share\\x',
    'C:\\Users\\x\\a.cmd',
    'c:x',
    'a\0b',
  ])('refuses %j', (path) => {
    expect(isSafeRelativeSkillPath(path)).toBe(false);
  });
});

describe('parseRepositoryIndex', () => {
  it('keeps a well formed index, absolute file urls included', () => {
    const parsed = parseRepositoryIndex(
      index({ files: [{ path: 'SKILL.md', url: 'https://example.com/demo/SKILL.md' }] }),
    );
    expect(parsed.skills[0].id).toBe('demo');
  });

  it('refuses an index whose skill id climbs out of the skills folder', () => {
    expect(() => parseRepositoryIndex(index({ id: 'x/../../..' }))).toThrow();
  });

  it('refuses an index whose file path climbs out of the skill folder', () => {
    expect(() =>
      parseRepositoryIndex(index({ files: [{ path: '../../settings.json', url: 'h.json' }] })),
    ).toThrow();
  });
});
