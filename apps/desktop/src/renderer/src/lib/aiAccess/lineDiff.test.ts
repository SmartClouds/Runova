import { describe, expect, it } from 'vitest';
import { diffLines, maskEnvLine } from './lineDiff';

/** The before and after of a file an agent wants to change, line by line, for the approval. */

describe('diffLines', () => {
  it('keeps unchanged lines in place and marks what was added and removed', () => {
    expect(diffLines('A=1\nB=2\nC=3', 'A=1\nB=9\nC=3\nD=4')).toEqual([
      { kind: 'same', text: 'A=1' },
      { kind: 'removed', text: 'B=2' },
      { kind: 'added', text: 'B=9' },
      { kind: 'same', text: 'C=3' },
      { kind: 'added', text: 'D=4' },
    ]);
  });

  it('treats a new file as all added, and ignores Windows line endings', () => {
    expect(diffLines('', 'A=1\r\nB=2\r\n')).toEqual([
      { kind: 'added', text: 'A=1' },
      { kind: 'added', text: 'B=2' },
    ]);
  });

  it('counts the changes', async () => {
    const { diffStats } = await import('./lineDiff');
    expect(diffStats(diffLines('A=1\nB=2', 'A=1\nC=3\nD=4'))).toEqual({ added: 2, removed: 1 });
  });
});

describe('maskEnvLine', () => {
  it('keeps the key and hides the value', () => {
    expect(maskEnvLine('API_KEY=abc123')).toBe('API_KEY=••••••');
    expect(maskEnvLine('export TOKEN = "x"')).toBe('export TOKEN =••••••');
  });

  it('leaves comments and blank lines alone and hides anything else whole', () => {
    expect(maskEnvLine('# staging values')).toBe('# staging values');
    expect(maskEnvLine('')).toBe('');
    expect(maskEnvLine('-----BEGIN KEY-----')).toBe('••••••');
  });
});
