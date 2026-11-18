import type { RunEstimates } from '@shared/apiTypes';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../../test/renderer/renderWithProviders';
import { useRunEstimates } from './useRunEstimates';

const runEstimates = vi.fn();

const ESTIMATES: RunEstimates = {
  runs: 3,
  run: { ms: 120_000, lowMs: 110_000, highMs: 130_000, samples: 3, confidence: 'medium' },
  jobs: {},
};

function render(enabled = true) {
  return renderHookWithProviders(() => useRunEstimates('acme/app', 7, 100, enabled), {
    bridge: { 'pipelines.runEstimates': runEstimates },
  });
}

beforeEach(() => {
  runEstimates.mockReset();
});

describe('useRunEstimates', () => {
  it("asks for the workflow's estimates, leaving the run on screen out", async () => {
    runEstimates.mockResolvedValue({ ok: true, estimates: ESTIMATES });

    const { result } = render();

    await waitFor(() => expect(result.current.data).toEqual(ESTIMATES));
    expect(runEstimates).toHaveBeenCalledWith({
      repo: 'acme/app',
      workflowId: 7,
      excludeRunId: 100,
    });
  });

  it('turns a refusal into an error, so the view simply goes without estimates', async () => {
    runEstimates.mockResolvedValue({ ok: false, error: 'HTTP 403' });

    const { result } = render();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('asks for nothing until it is wanted', () => {
    render(false);
    expect(runEstimates).not.toHaveBeenCalled();
  });
});
