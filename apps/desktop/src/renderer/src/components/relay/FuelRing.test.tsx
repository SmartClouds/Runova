import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FuelRing, fuelLevel } from './FuelRing';

describe('fuelLevel', () => {
  it('stays calm well under the budget, warms near the guard, and turns hot past it', () => {
    expect(fuelLevel(50_000, 200_000, 160_000)).toBe('calm');
    expect(fuelLevel(130_000, 200_000, 160_000)).toBe('warm');
    expect(fuelLevel(161_000, 200_000, 160_000)).toBe('hot');
    expect(fuelLevel(170_000, 200_000, null)).toBe('warm');
    expect(fuelLevel(null, 200_000, 160_000)).toBe('unknown');
  });
});

describe('FuelRing', () => {
  it('reads as a meter of the context used against the budget', () => {
    render(<FuelRing used={84_000} budget={200_000} guardAt={160_000} />);
    const meter = screen.getByRole('meter', { name: 'Context used' });
    expect(meter).toHaveAttribute('aria-valuenow', '84000');
    expect(meter).toHaveAttribute('aria-valuemax', '200000');
    expect(meter).toHaveAttribute('aria-valuetext', '84K of 200K tokens, 42%');
  });

  it('marks where the guard tells the session to hand off', () => {
    const { container } = render(<FuelRing used={10_000} budget={200_000} guardAt={160_000} />);
    expect(container.querySelector('[data-guard-tick]')).not.toBeNull();
  });

  it('can turn hot at the guard without drawing its mark, for a ring too small to show it', () => {
    const { container } = render(
      <FuelRing used={180_000} budget={200_000} guardAt={170_000} size={14} tick={false} />,
    );
    expect(container.querySelector('[data-guard-tick]')).toBeNull();
    expect(screen.getByRole('meter')).toHaveAttribute('data-level', 'hot');
  });

  it('says so when the CLI cannot report its context', () => {
    render(<FuelRing used={null} budget={200_000} guardAt={null} />);
    expect(screen.getByRole('meter', { name: 'Context used' })).toHaveAttribute(
      'aria-valuetext',
      'Not reported by this CLI',
    );
  });
});
