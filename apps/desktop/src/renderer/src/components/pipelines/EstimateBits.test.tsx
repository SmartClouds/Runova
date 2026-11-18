import type { DurationEstimate } from '@shared/apiTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { DeltaChip, EtaBar, EtaText, UsualHint } from './EstimateBits';

const USUAL: DurationEstimate = {
  ms: 190_000,
  lowMs: 170_000,
  highMs: 210_000,
  samples: 8,
  confidence: 'high',
};

describe('EtaBar', () => {
  it('is a progress bar that says how far along it is and what is left', () => {
    renderWithProviders(
      <EtaBar
        label="build"
        eta={{ remainingMs: 80_000, overByMs: 0, fraction: 0.42 }}
        estimate={USUAL}
      />,
    );

    const bar = screen.getByRole('progressbar', { name: 'build progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuetext', '~1m 20s left');
    expect(bar.querySelector('[data-fill]')).toHaveStyle({ width: '42%' });
    expect(bar).toHaveAttribute('data-state', 'on-time');
  });

  it('turns to a warning once it runs past the usual time', () => {
    renderWithProviders(
      <EtaBar
        label="build"
        eta={{ remainingMs: 0, overByMs: 30_000, fraction: 0.99 }}
        estimate={USUAL}
      />,
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('data-state', 'over');
  });

  it('marks a rough guess, so it does not look more certain than it is', () => {
    renderWithProviders(
      <EtaBar
        label="build"
        eta={{ remainingMs: 10_000, overByMs: 0, fraction: 0.5 }}
        estimate={{ ...USUAL, samples: 1, confidence: 'low' }}
      />,
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('data-confidence', 'low');
  });

  it('explains where the estimate comes from on hover', async () => {
    const { user } = renderWithProviders(
      <EtaBar
        label="build"
        eta={{ remainingMs: 80_000, overByMs: 0, fraction: 0.4 }}
        estimate={USUAL}
      />,
    );

    await user.hover(screen.getByRole('progressbar'));

    expect(
      (await screen.findAllByText('Usually 3m 10s (2m 50s to 3m 30s), from 8 passing runs.'))
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('EtaText', () => {
  it('says what is left', () => {
    renderWithProviders(
      <EtaText eta={{ remainingMs: 80_000, overByMs: 0, fraction: 0.4 }} estimate={USUAL} />,
    );
    expect(screen.getByText('~1m 20s left')).toBeTruthy();
  });

  it('warns once it is running long', () => {
    renderWithProviders(
      <EtaText eta={{ remainingMs: 0, overByMs: 62_000, fraction: 0.99 }} estimate={USUAL} />,
    );
    expect(screen.getByText('1m longer than usual')).toHaveClass('text-warning');
  });
});

describe('UsualHint', () => {
  it('shows roughly how long something that has not started usually takes', () => {
    renderWithProviders(<UsualHint estimate={USUAL} />);
    expect(screen.getByLabelText('Usually about 3m 10s')).toHaveTextContent('~3m 10s');
  });
});

describe('DeltaChip', () => {
  it('calls out a run that was slower than usual', () => {
    renderWithProviders(<DeltaChip actualMs={240_000} estimate={USUAL} />);
    expect(screen.getByLabelText('50s slower than usual')).toHaveTextContent('50s slower');
  });

  it('calls out a run that was faster than usual', () => {
    renderWithProviders(<DeltaChip actualMs={150_000} estimate={USUAL} />);
    expect(screen.getByLabelText('40s faster than usual')).toHaveTextContent('40s faster');
  });

  it('can be limited to slow runs, for rows that should stay calm', () => {
    renderWithProviders(<DeltaChip actualMs={150_000} estimate={USUAL} only="slower" />);
    expect(screen.queryByLabelText(/faster/)).toBeNull();
  });

  it('shows nothing for an ordinary run', () => {
    const { container } = renderWithProviders(<DeltaChip actualMs={195_000} estimate={USUAL} />);
    expect(container.textContent).toBe('');
  });
});
