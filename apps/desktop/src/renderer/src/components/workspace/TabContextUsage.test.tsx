import type { AgentContextUsage } from '@shared/apiTypes';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_REFRESH_MS } from '@/stores/contextUsageStore';
import { useUiStore } from '@/stores/uiStore';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { TabContextUsage } from './TabContextUsage';

const usage = (tokens: number): AgentContextUsage => ({ tokens, window: 200_000 });

function answer(value: AgentContextUsage | null) {
  return installRunovaBridge({ 'agents.contextUsage': async () => value });
}

function header(): HTMLElement {
  return screen.getByRole('button', { name: /Context window/ });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TabContextUsage', () => {
  it('starts closed, peeking at the percent only', async () => {
    answer(usage(84_100));
    render(<TabContextUsage sessionId="tab-1" />);

    expect(await screen.findByText('42%')).toBeInTheDocument();
    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('84.1K of 200K tokens used')).not.toBeInTheDocument();
  });

  it('opens to the bar and token counts, and remembers that for every tab', async () => {
    answer(usage(84_100));
    const user = userEvent.setup();
    render(<TabContextUsage sessionId="tab-1" />);
    await screen.findByText('42%');

    await user.click(header());

    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('84.1K of 200K tokens used')).toBeInTheDocument();
    expect(screen.getByText('115.9K left')).toBeInTheDocument();
    expect(screen.getByTestId('context-bar')).toHaveStyle({ width: '42.05%' });
    expect(useUiStore.getState().tabContextOpen).toBe(true);

    await user.click(header());
    expect(useUiStore.getState().tabContextOpen).toBe(false);
    expect(screen.queryByText('115.9K left')).not.toBeInTheDocument();
  });

  it('opens straight to the details when it was left open', async () => {
    answer(usage(84_100));
    useUiStore.getState().setTabContextOpen(true);
    render(<TabContextUsage sessionId="tab-1" />);

    expect(await screen.findByText('84.1K of 200K tokens used')).toBeInTheDocument();
    expect(header()).toHaveAttribute('aria-expanded', 'true');
  });

  it('follows the session while it is shown', async () => {
    vi.useFakeTimers();
    let tokens = 84_100;
    installRunovaBridge({ 'agents.contextUsage': async () => usage(tokens) });
    const { container } = render(<TabContextUsage sessionId="tab-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('data-level', 'calm');

    tokens = 175_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTEXT_REFRESH_MS);
    });

    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('data-level', 'hot');
  });

  it('shows a placeholder until the first reading arrives', () => {
    installRunovaBridge({ 'agents.contextUsage': () => new Promise(() => undefined) });
    render(<TabContextUsage sessionId="tab-1" />);

    expect(screen.getByTestId('context-loading')).toBeInTheDocument();
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it('says when there is nothing to measure yet', async () => {
    answer(null);
    useUiStore.getState().setTabContextOpen(true);
    const { container } = render(<TabContextUsage sessionId="tab-1" />);

    expect(await screen.findByText('Appears once Claude replies')).toBeInTheDocument();
    expect(screen.queryByTestId('context-loading')).not.toBeInTheDocument();
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('data-level', 'unknown');
  });

  it('keeps its clicks to itself, so the tab keeps focus and the card stays open', async () => {
    answer(usage(84_100));
    const outside = vi.fn();
    // The div stands in for the tab strip and pane group around the card.
    render(
      <div onClick={outside} onMouseDown={outside} onPointerDown={outside}>
        <TabContextUsage sessionId="tab-1" />
      </div>,
    );
    await screen.findByText('42%');

    // A prevented mousedown is what keeps focus where it was.
    expect(fireEvent.mouseDown(header())).toBe(false);
    fireEvent.pointerDown(header());
    fireEvent.click(header());

    expect(outside).not.toHaveBeenCalled();
    expect(header()).toHaveAttribute('aria-expanded', 'true');
  });
});
