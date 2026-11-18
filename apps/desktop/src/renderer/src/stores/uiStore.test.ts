import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './uiStore';

function mode() {
  return useUiStore.getState().sidebarMode;
}

beforeEach(() => {
  useUiStore.setState({ sidebarMode: 'expanded' });
});

describe('useUiStore', () => {
  it('starts with the sidebar showing its labels', () => {
    expect(mode()).toBe('expanded');
  });

  it('cycles labels, icons, then closed, and back round', () => {
    // "hidden" takes the width away entirely rather than floating a panel over the page.
    useUiStore.getState().cycleSidebarMode();
    expect(mode()).toBe('collapsed');
    useUiStore.getState().cycleSidebarMode();
    expect(mode()).toBe('hidden');
    useUiStore.getState().cycleSidebarMode();
    expect(mode()).toBe('expanded');
  });

  it('cycles on from whatever was restored', () => {
    useUiStore.setState({ sidebarMode: 'hidden' });
    useUiStore.getState().cycleSidebarMode();
    expect(mode()).toBe('expanded');
  });
});

describe('coming back from a saved preference', () => {
  it('restores the mode the sidebar was left in', async () => {
    localStorage.setItem(
      'runova-ui',
      JSON.stringify({ state: { sidebarMode: 'collapsed' }, version: 0 }),
    );
    await useUiStore.persist.rehydrate();
    expect(mode()).toBe('collapsed');
  });

  it('saves the mode whenever it changes', () => {
    useUiStore.getState().cycleSidebarMode();
    const saved = JSON.parse(localStorage.getItem('runova-ui') ?? '{}');
    expect(saved.state.sidebarMode).toBe('collapsed');
  });
});

describe('the context section of a tab hover card', () => {
  it('starts closed, so a hover card only peeks at the percent', () => {
    expect(useUiStore.getInitialState().tabContextOpen).toBe(false);
  });

  it('saves whether it was left open', () => {
    useUiStore.getState().setTabContextOpen(true);
    expect(useUiStore.getState().tabContextOpen).toBe(true);
    const saved = JSON.parse(localStorage.getItem('runova-ui') ?? '{}');
    expect(saved.state.tabContextOpen).toBe(true);
  });

  it('comes back open on the next start', async () => {
    localStorage.setItem(
      'runova-ui',
      JSON.stringify({ state: { sidebarMode: 'expanded', tabContextOpen: true }, version: 0 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().tabContextOpen).toBe(true);
  });
});
