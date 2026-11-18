import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunwayProgress } from './RunwayProgress';

describe('the runway progress bar', () => {
  it('says how far a transfer is, as a percentage', () => {
    render(<RunwayProgress label="To Office PC" value={46} total={100} tone="moving" />);

    const bar = screen.getByRole('progressbar', { name: 'To Office PC' });
    expect(bar).toHaveAttribute('aria-valuenow', '46');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('gives no number while it waits for an answer', () => {
    render(<RunwayProgress label="Waiting" value={0} total={100} tone="waiting" />);

    expect(screen.getByRole('progressbar', { name: 'Waiting' })).not.toHaveAttribute(
      'aria-valuenow',
    );
  });

  it('never claims more than all of it', () => {
    render(<RunwayProgress label="Done" value={120} total={100} tone="done" />);

    expect(screen.getByRole('progressbar', { name: 'Done' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });
});
