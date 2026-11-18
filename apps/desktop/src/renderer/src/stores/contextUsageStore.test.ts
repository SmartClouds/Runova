import type { AgentContextUsage } from '@shared/apiTypes';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import {
  CONTEXT_REFRESH_MS,
  refreshContextUsage,
  useContextUsage,
  useContextUsageStore,
  useLiveContextUsage,
} from './contextUsageStore';

const usage = (tokens: number): AgentContextUsage => ({ tokens, window: 200_000 });

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshContextUsage', () => {
  it('keeps what main measured for the tab', async () => {
    const bridge = installRunovaBridge({
      'agents.contextUsage': async (id: string) => (id === 'tab-1' ? usage(84_100) : null),
    });

    await refreshContextUsage('tab-1');
    await refreshContextUsage('tab-2');

    expect(bridge.$fn('agents.contextUsage')).toHaveBeenCalledWith('tab-1');
    expect(useContextUsageStore.getState().usage).toEqual({
      'tab-1': usage(84_100),
      'tab-2': null,
    });
  });

  it('reads no answer as nothing to show yet', async () => {
    installRunovaBridge({ 'agents.contextUsage': async () => undefined });

    await refreshContextUsage('tab-1');

    expect(useContextUsageStore.getState().usage['tab-1']).toBeNull();
  });

  it('keeps the last reading when main cannot be reached', async () => {
    installRunovaBridge({ 'agents.contextUsage': async () => usage(10_000) });
    await refreshContextUsage('tab-1');

    installRunovaBridge({
      'agents.contextUsage': async () => {
        throw new Error('gone');
      },
    });
    await refreshContextUsage('tab-1');

    expect(useContextUsageStore.getState().usage['tab-1']).toEqual(usage(10_000));
  });

  it('lets the newest reading win over a slower older one', async () => {
    const answers: ((value: AgentContextUsage) => void)[] = [];
    installRunovaBridge({
      'agents.contextUsage': () =>
        new Promise<AgentContextUsage>((resolve) => {
          answers.push(resolve);
        }),
    });

    const older = refreshContextUsage('tab-1');
    const newer = refreshContextUsage('tab-1');
    answers[1](usage(90_000));
    await newer;
    answers[0](usage(80_000));
    await older;

    expect(useContextUsageStore.getState().usage['tab-1']).toEqual(usage(90_000));
  });
});

describe('useLiveContextUsage', () => {
  it('reads straight away and keeps reading while it is shown', async () => {
    vi.useFakeTimers();
    let tokens = 84_100;
    const bridge = installRunovaBridge({
      'agents.contextUsage': async () => usage(tokens),
    });

    const { result, unmount } = renderHook(() => useLiveContextUsage('tab-1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual(usage(84_100));

    tokens = 120_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTEXT_REFRESH_MS);
    });
    expect(result.current).toEqual(usage(120_000));

    unmount();
    const calls = bridge.$fn('agents.contextUsage').mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTEXT_REFRESH_MS * 3);
    });
    expect(bridge.$fn('agents.contextUsage').mock.calls.length).toBe(calls);
  });

  it('shows the last reading at once when it opens again', async () => {
    installRunovaBridge({ 'agents.contextUsage': () => new Promise(() => undefined) });
    useContextUsageStore.setState({ usage: { 'tab-1': usage(50_000) } });

    const { result } = renderHook(() => useLiveContextUsage('tab-1'));

    expect(result.current).toEqual(usage(50_000));
  });
});

describe('useContextUsage', () => {
  it('is undefined for a tab that was never read', () => {
    const { result } = renderHook(() => useContextUsage('never'));
    expect(result.current).toBeUndefined();
  });
});
