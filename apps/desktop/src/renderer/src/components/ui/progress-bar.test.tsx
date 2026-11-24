import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressBar } from './progress-bar';

describe('ProgressBar', () => {
  it('is a labelled progressbar with its value', () => {
    render(<ProgressBar value={42} label="Cloning acme/app" valueText="Downloading, 42%" />);

    const bar = screen.getByRole('progressbar', { name: 'Cloning acme/app' });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuetext', 'Downloading, 42%');
  });

  it('keeps the value between 0 and 100 and rounds it', () => {
    const { rerender } = render(<ProgressBar value={140} label="Bar" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    rerender(<ProgressBar value={-5} label="Bar" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

    rerender(<ProgressBar value={33.6} label="Bar" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '34');
  });

  it('leaves the value out while it does not know one yet', () => {
    render(<ProgressBar value={null} label="Bar" />);

    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('data-indeterminate', 'true');
  });

  it('draws a notch at each mark and says which tone it is in', () => {
    const { container } = render(
      <ProgressBar value={50} label="Bar" tone="danger" marks={[10, 75]} />,
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('data-tone', 'danger');
    const notches = container.querySelectorAll('[data-mark]');
    expect([...notches].map((notch) => (notch as HTMLElement).style.left)).toEqual(['10%', '75%']);
  });

  it('only shimmers while it is live', () => {
    const { container, rerender } = render(<ProgressBar value={50} label="Bar" live />);
    expect(container.querySelector('.eta-sheen')).not.toBeNull();

    rerender(<ProgressBar value={50} label="Bar" />);
    expect(container.querySelector('.eta-sheen')).toBeNull();
  });
});
