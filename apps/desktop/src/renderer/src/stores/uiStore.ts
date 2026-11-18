import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarMode = 'expanded' | 'collapsed' | 'hidden';

// Cycle order for the single toggle button: full labels, icons only, then
// closed completely (no width at all, so it pushes the page content back
// over instead of floating a panel on top of it).
const SIDEBAR_MODE_CYCLE: SidebarMode[] = ['expanded', 'collapsed', 'hidden'];

interface UiState {
  sidebarMode: SidebarMode;
  cycleSidebarMode: () => void;
  /**
   * Whether the context section of a Claude Code tab's hover card is open. One choice for every
   * tab: closed, the card only peeks at the percent; open, it shows the bar and token counts.
   */
  tabContextOpen: boolean;
  setTabContextOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarMode: 'expanded',
      cycleSidebarMode: () =>
        set((s) => {
          const nextIndex =
            (SIDEBAR_MODE_CYCLE.indexOf(s.sidebarMode) + 1) % SIDEBAR_MODE_CYCLE.length;
          return { sidebarMode: SIDEBAR_MODE_CYCLE[nextIndex] };
        }),
      tabContextOpen: false,
      setTabContextOpen: (open) => set({ tabContextOpen: open }),
    }),
    { name: 'runova-ui' },
  ),
);
