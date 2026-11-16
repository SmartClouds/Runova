import { describe, expect, it } from 'vitest';
import type { CleanStep } from './cleanSteps';
import { unsafeStep } from './safety';

const posix = { home: '/home/ci', runnerDirs: ['/home/ci/actions-runner/a', '/opt/old'] };
const windows = { home: 'C:\\Users\\ci', runnerDirs: ['C:\\actions-runner'] };

function remove(path: string): CleanStep {
  return { id: 'x', busyGuard: null, measure: [path], actions: [{ kind: 'remove', path }] };
}

describe('unsafeStep', () => {
  it('lets through paths inside a runner folder or a home', () => {
    expect(unsafeStep(remove('/home/ci/actions-runner/a/_work/web'), posix)).toBeNull();
    expect(unsafeStep(remove('/home/ci/.npm/_cacache'), posix)).toBeNull();
    expect(unsafeStep(remove('C:\\actions-runner\\_work\\web'), windows)).toBeNull();
    expect(
      unsafeStep(remove('C:\\Users\\ci\\AppData\\Local\\npm-cache\\_cacache'), windows),
    ).toBeNull();
  });

  it('refuses a root, a home, a relative path or one that climbs out', () => {
    expect(unsafeStep(remove('/'), posix)).toMatch(/not allowed/);
    expect(unsafeStep(remove('/home/ci'), posix)).toMatch(/not allowed/);
    expect(unsafeStep(remove('/home/ci/'), posix)).toMatch(/not allowed/);
    expect(unsafeStep(remove('home/ci/x'), posix)).toMatch(/not allowed/);
    expect(unsafeStep(remove('/home/ci/actions-runner/a/../../..'), posix)).toMatch(/not allowed/);
    expect(unsafeStep(remove('C:\\'), windows)).toMatch(/not allowed/);
    expect(unsafeStep(remove('C:\\Users\\CI'), windows)).toMatch(/not allowed/);
    expect(unsafeStep(remove('/etc/passwd'), posix)).toMatch(/not allowed/);
  });

  it('refuses a runner folder itself unless the step removes that runner', () => {
    expect(unsafeStep(remove('/opt/old'), posix)).toMatch(/not allowed/);
    expect(
      unsafeStep(
        {
          id: 'gone',
          busyGuard: '/opt/old',
          measure: ['/opt/old'],
          actions: [{ kind: 'removeRunner', path: '/opt/old' }],
        },
        posix,
      ),
    ).toBeNull();
    expect(
      unsafeStep(
        {
          id: 'gone',
          busyGuard: null,
          measure: [],
          actions: [{ kind: 'removeRunner', path: '/opt/not-a-runner' }],
        },
        posix,
      ),
    ).toMatch(/not allowed/);
  });

  it('lets Docker through, which names no path', () => {
    expect(
      unsafeStep(
        { id: 'd', busyGuard: null, measure: [], actions: [{ kind: 'docker', prune: 'dangling' }] },
        posix,
      ),
    ).toBeNull();
  });
});
