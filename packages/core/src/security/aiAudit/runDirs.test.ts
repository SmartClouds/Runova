import { describe, expect, it } from 'vitest';
import { auditRunNumber, isAuditRunName, nextAuditRunName } from './runDirs.js';

/**
 * Run folders are named by the skill as run-<N>. The name crosses IPC from the renderer, so it is
 * checked against that exact shape before it is ever joined onto a path.
 */

describe('isAuditRunName', () => {
  it('accepts the names the skill writes', () => {
    expect(isAuditRunName('run-1')).toBe(true);
    expect(isAuditRunName('run-42')).toBe(true);
  });

  it('rejects anything that could reach outside the runs folder', () => {
    for (const name of ['../x', 'run-', 'run-3/..', 'run-3\\..', 'run-a', ' run-1', 'run-1 ', '']) {
      expect(isAuditRunName(name), name).toBe(false);
    }
  });
});

describe('auditRunNumber', () => {
  it('reads the number out of a run name', () => {
    expect(auditRunNumber('run-12')).toBe(12);
    expect(auditRunNumber('notes')).toBeNull();
  });
});

describe('nextAuditRunName', () => {
  it('starts at run-1', () => {
    expect(nextAuditRunName([])).toBe('run-1');
  });

  it('goes one past the highest run, gaps and stray folders aside', () => {
    expect(nextAuditRunName(['run-1', 'run-4', 'notes', 'run-2'])).toBe('run-5');
  });
});
