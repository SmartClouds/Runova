import { describe, expect, it } from 'vitest';
import { fileKind, initials } from './fileKinds';

describe('what kind of file a name is', () => {
  it.each([
    ['beach.JPG', 'image'],
    ['clip.mov', 'video'],
    ['song.flac', 'audio'],
    ['backup.tar.gz', 'archive'],
    ['main.ts', 'code'],
    ['report.pdf', 'document'],
    ['notes', 'other'],
    ['.env', 'other'],
  ])('reads %s as %s', (name, kind) => {
    expect(fileKind(name)).toBe(kind);
  });
});

describe('a person as initials', () => {
  it('takes the first letter of the first two names', () => {
    expect(initials('Ali Rezaei')).toBe('AR');
    expect(initials('sam')).toBe('S');
    expect(initials('  ')).toBe('?');
  });
});
