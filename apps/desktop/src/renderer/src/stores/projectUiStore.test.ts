import { describe, expect, it } from 'vitest';
import { projectUiKey, useProjectUiStore } from './projectUiStore';

describe('projectUiStore', () => {
  it('starts empty', () => {
    expect(useProjectUiStore.getState().values).toEqual({});
  });

  it('keeps a value under its project and key', () => {
    useProjectUiStore.getState().set('p1', 'packages.filter', 'outdated');
    expect(useProjectUiStore.getState().values[projectUiKey('p1', 'packages.filter')]).toBe(
      'outdated',
    );
  });

  it('keeps projects apart, even for the same key', () => {
    const { set } = useProjectUiStore.getState();
    set('p1', 'packages.query', 'react');
    set('p2', 'packages.query', 'vite');
    const { values } = useProjectUiStore.getState();
    expect(values[projectUiKey('p1', 'packages.query')]).toBe('react');
    expect(values[projectUiKey('p2', 'packages.query')]).toBe('vite');
  });

  it('holds values that are not plain data', () => {
    const picked = new Set(['npm:react', 'npm:vite']);
    useProjectUiStore.getState().set('p1', 'packages.selected', picked);
    expect(useProjectUiStore.getState().values[projectUiKey('p1', 'packages.selected')]).toBe(
      picked,
    );
  });

  it('forgets one project and leaves the others', () => {
    const { set, clear } = useProjectUiStore.getState();
    set('p1', 'a', 1);
    set('p1', 'b', 2);
    set('p10', 'a', 3);
    set('p2', 'a', 4);

    clear('p1');

    expect(useProjectUiStore.getState().values).toEqual({
      [projectUiKey('p10', 'a')]: 3,
      [projectUiKey('p2', 'a')]: 4,
    });
  });
});
