import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useProjectUiStore } from '@/stores/projectUiStore';
import { ProjectUiScope, useProjectUiState } from './useProjectUiState';

function scoped(projectId: string) {
  return function Wrapper({ children }: { children: ReactNode }): React.JSX.Element {
    return <ProjectUiScope.Provider value={projectId}>{children}</ProjectUiScope.Provider>;
  };
}

describe('useProjectUiState', () => {
  it('starts at the given value', () => {
    const { result } = renderHook(() => useProjectUiState('filter', 'all'), {
      wrapper: scoped('p1'),
    });
    expect(result.current[0]).toBe('all');
  });

  it('gives a value back after the component has been unmounted', () => {
    const first = renderHook(() => useProjectUiState('query', ''), { wrapper: scoped('p1') });
    act(() => first.result.current[1]('react'));
    expect(first.result.current[0]).toBe('react');
    first.unmount();

    const second = renderHook(() => useProjectUiState('query', ''), { wrapper: scoped('p1') });
    expect(second.result.current[0]).toBe('react');
  });

  it('keeps one project from seeing the value of another', () => {
    const first = renderHook(() => useProjectUiState('query', ''), { wrapper: scoped('p1') });
    act(() => first.result.current[1]('react'));

    const other = renderHook(() => useProjectUiState('query', ''), { wrapper: scoped('p2') });
    expect(other.result.current[0]).toBe('');
  });

  it('keeps one key from seeing the value of another', () => {
    const first = renderHook(() => useProjectUiState('one', 'a'), { wrapper: scoped('p1') });
    act(() => first.result.current[1]('changed'));

    const other = renderHook(() => useProjectUiState('two', 'b'), { wrapper: scoped('p1') });
    expect(other.result.current[0]).toBe('b');
  });

  it('can be put back to the starting value, which then stays', () => {
    const first = renderHook(() => useProjectUiState('filter', 'all'), { wrapper: scoped('p1') });
    act(() => first.result.current[1]('outdated'));
    act(() => first.result.current[1]('all'));
    first.unmount();

    const second = renderHook(() => useProjectUiState('filter', 'other'), {
      wrapper: scoped('p1'),
    });
    expect(second.result.current[0]).toBe('all');
  });

  it('takes an updater function, built on the latest value', () => {
    const { result } = renderHook(() => useProjectUiState('count', 0), { wrapper: scoped('p1') });
    act(() => {
      result.current[1]((count) => count + 1);
      result.current[1]((count) => count + 1);
    });
    expect(result.current[0]).toBe(2);
  });

  it('builds a lazy starting value once', () => {
    let built = 0;
    const { result, rerender } = renderHook(
      () =>
        useProjectUiState<Set<string>>('selected', () => {
          built += 1;
          return new Set();
        }),
      { wrapper: scoped('p1') },
    );
    const initial = result.current[0];
    rerender();
    rerender();
    expect(result.current[0]).toBe(initial);
    expect(built).toBe(1);
  });

  it('keeps a Set as the same object it was given', () => {
    const first = renderHook(() => useProjectUiState<Set<string>>('selected', () => new Set()), {
      wrapper: scoped('p1'),
    });
    const picked = new Set(['npm:react']);
    act(() => first.result.current[1](picked));
    first.unmount();

    const second = renderHook(() => useProjectUiState<Set<string>>('selected', () => new Set()), {
      wrapper: scoped('p1'),
    });
    expect(second.result.current[0]).toBe(picked);
  });

  it('hands out a setter that does not change between renders', () => {
    const { result, rerender } = renderHook(() => useProjectUiState('query', ''), {
      wrapper: scoped('p1'),
    });
    const setter = result.current[1];
    act(() => setter('react'));
    rerender();
    expect(result.current[1]).toBe(setter);
  });

  it('writes nothing to the store when the value is set to what it already is', () => {
    const { result } = renderHook(() => useProjectUiState('query', ''), { wrapper: scoped('p1') });
    act(() => result.current[1]('react'));
    const before = useProjectUiStore.getState().values;
    act(() => result.current[1]('react'));
    expect(useProjectUiStore.getState().values).toBe(before);
  });

  it('is plain component state without a project, and stores nothing', () => {
    const first = renderHook(() => useProjectUiState('query', ''));
    act(() => first.result.current[1]('react'));
    expect(first.result.current[0]).toBe('react');
    expect(useProjectUiStore.getState().values).toEqual({});
    first.unmount();

    const second = renderHook(() => useProjectUiState('query', ''));
    expect(second.result.current[0]).toBe('');
  });
});
