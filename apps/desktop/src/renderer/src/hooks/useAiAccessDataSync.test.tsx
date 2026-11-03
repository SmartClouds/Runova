import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { queryKeysForChange, useAiAccessDataSync } from './useAiAccessDataSync';

/**
 * When an agent changes something through AI access, the screens showing it refetch, so a change
 * made from the CLI shows up in Runova without a reload.
 */

describe('queryKeysForChange', () => {
  it('names the queries that show what an area changed', () => {
    expect(queryKeysForChange({ area: 'environments', projectId: 'p1' })).toEqual([
      ['project-environments', 'p1'],
      ['env-file-history'],
    ]);
    expect(queryKeysForChange({ area: 'apiClient', projectId: null })).toEqual([
      ['api-collections'],
    ]);
    expect(queryKeysForChange({ area: 'projects', projectId: 'p1' })).toEqual([['projects']]);
  });

  it('refetches everything for an area it has no list for', () => {
    expect(queryKeysForChange({ area: 'studio', projectId: null })).toBeNull();
  });
});

describe('useAiAccessDataSync', () => {
  it('invalidates the matching queries when Runova announces a change', async () => {
    const { bridge, queryClient } = renderHookWithProviders(() => useAiAccessDataSync());
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => bridge.$emit('aiAccess.onDataChanged', { area: 'apiClient', projectId: null }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['api-collections'] });

    act(() => bridge.$emit('aiAccess.onDataChanged', { area: 'studio', projectId: null }));
    expect(invalidate).toHaveBeenLastCalledWith();
  });
});
