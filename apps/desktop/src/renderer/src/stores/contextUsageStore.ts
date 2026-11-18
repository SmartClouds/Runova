import type { AgentContextUsage } from '@shared/apiTypes';
import { useEffect } from 'react';
import { create } from 'zustand';

interface ContextUsageState {
  /** The last reading per tab: null when the session has nothing to measure yet. */
  usage: Record<string, AgentContextUsage | null>;
}

/**
 * How full each Claude Code tab's context window was when last read. Only read while a tab's
 * hover card shows it, and kept so the card opens with the last reading instead of a blank.
 * Not persisted.
 */
export const useContextUsageStore = create<ContextUsageState>(() => ({ usage: {} }));

/** How often an open card reads again, so its numbers follow the session as it works. */
export const CONTEXT_REFRESH_MS = 1_500;

let lastRequest = 0;
const latestRequest = new Map<string, number>();

function sameUsage(a: AgentContextUsage | null | undefined, b: AgentContextUsage | null): boolean {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  return a.tokens === b.tokens && a.window === b.window;
}

/** Asks main for a tab's context now. A slower older answer never replaces a newer one. */
export async function refreshContextUsage(sessionId: string): Promise<void> {
  lastRequest += 1;
  const request = lastRequest;
  latestRequest.set(sessionId, request);
  let answer: AgentContextUsage | null;
  try {
    answer = (await window.runova.agents.contextUsage(sessionId)) ?? null;
  } catch {
    // Keep showing the last reading rather than blanking the card over one missed read.
    return;
  }
  if (latestRequest.get(sessionId) !== request) return;
  if (sameUsage(useContextUsageStore.getState().usage[sessionId], answer)) return;
  useContextUsageStore.setState((state) => ({ usage: { ...state.usage, [sessionId]: answer } }));
}

/** The last reading of a tab, undefined when it was never read. */
export function useContextUsage(sessionId: string): AgentContextUsage | null | undefined {
  return useContextUsageStore((state) => state.usage[sessionId]);
}

/** A tab's context, read as soon as this mounts and again every few seconds until it unmounts. */
export function useLiveContextUsage(sessionId: string): AgentContextUsage | null | undefined {
  useEffect(() => {
    void refreshContextUsage(sessionId);
    const timer = window.setInterval(() => void refreshContextUsage(sessionId), CONTEXT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [sessionId]);
  return useContextUsage(sessionId);
}
