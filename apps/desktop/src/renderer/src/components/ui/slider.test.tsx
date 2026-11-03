import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from './slider';

describe('Slider', () => {
  it('is a range input with its bounds and value', () => {
    render(
      <Slider aria-label="Cores" value={2} min={1} max={8} step={1} onValueChange={vi.fn()} />,
    );
    const slider = screen.getByRole('slider', { name: 'Cores' });
    expect(slider).toHaveAttribute('type', 'range');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '8');
    expect(slider).toHaveValue('2');
  });

  it('reports a new value as a number', () => {
    const onValueChange = vi.fn();
    render(<Slider aria-label="Cores" value={2} min={1} max={8} onValueChange={onValueChange} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Cores' }), { target: { value: '5' } });
    expect(onValueChange).toHaveBeenCalledWith(5);
  });

  it('reads its value out in words when given them', () => {
    render(
      <Slider
        aria-label="Max usage"
        value={50}
        min={5}
        max={100}
        valueLabel="50%"
        onValueChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('slider', { name: 'Max usage' })).toHaveAttribute(
      'aria-valuetext',
      '50%',
    );
  });

  it('fills the track up to the value', () => {
    render(<Slider aria-label="Cores" value={5} min={1} max={9} onValueChange={vi.fn()} />);
    expect(
      screen.getByRole('slider', { name: 'Cores' }).style.getPropertyValue('--range-pct'),
    ).toBe('50%');
  });

  it('can be turned off', () => {
    render(
      <Slider aria-label="Cores" value={1} min={1} max={8} disabled onValueChange={vi.fn()} />,
    );
    expect(screen.getByRole('slider', { name: 'Cores' })).toBeDisabled();
  });
});
