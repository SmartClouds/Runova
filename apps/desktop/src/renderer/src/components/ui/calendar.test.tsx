import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Calendar, dayOf, localToday, parseDay } from './calendar';

describe('day strings', () => {
  it('parses a real day and refuses one that does not exist', () => {
    expect(parseDay('2026-02-28')).toBe(Date.UTC(2026, 1, 28));
    expect(parseDay('2026-02-31')).toBeNull();
    expect(parseDay('')).toBeNull();
    expect(dayOf(Date.UTC(2026, 10, 22))).toBe('2026-11-22');
    expect(localToday(new Date(2026, 10, 22, 23, 59))).toBe('2026-11-22');
  });
});

describe('Calendar', () => {
  it('opens on the picked month and hands back the day that was clicked', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Calendar selected="2026-11-16" today="2026-11-22" onSelect={onSelect} />);

    expect(screen.getByRole('grid', { name: 'November 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /November 16, 2026/ })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('button', { name: /November 22, 2026/ })).toHaveAttribute(
      'aria-current',
      'date',
    );
    await user.click(screen.getByRole('button', { name: /November 18, 2026/ }));
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-18');
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-22');
  });

  it('keeps days past the last allowed one out of reach', () => {
    render(<Calendar selected="2026-11-20" max="2026-11-22" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /November 22, 2026/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /November 23, 2026/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  it('tints the span between the two ends of a range', () => {
    render(<Calendar selected="2026-11-16" rangeWith="2026-11-18" onSelect={vi.fn()} />);
    const cell = (day: number) =>
      screen.getByRole('button', { name: new RegExp(`November ${day}, 2026`) }).parentElement;
    expect(cell(16)).toHaveClass('bg-primary/12', 'rounded-l-full');
    expect(cell(17)).toHaveClass('bg-primary/12');
    expect(cell(18)).toHaveClass('rounded-r-full');
    expect(cell(19)).not.toHaveClass('bg-primary/12');
  });

  it('walks months with the arrows and jumps straight to a month and year', async () => {
    const user = userEvent.setup();
    render(<Calendar selected="2026-01-31" onSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('grid', { name: 'February 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /February 28, 2026/ })).toHaveAttribute(
      'tabindex',
      '0',
    );

    await user.click(screen.getByRole('button', { name: 'Choose month and year' }));
    await user.click(screen.getByRole('button', { name: 'Previous year' }));
    await user.click(screen.getByRole('button', { name: 'Aug' }));
    expect(screen.getByRole('grid', { name: 'August 2025' })).toBeInTheDocument();
  });

  it('moves between days with the keyboard', () => {
    render(<Calendar selected="2026-11-30" onSelect={vi.fn()} />);
    const grid = screen.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(screen.getByRole('grid', { name: 'December 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /December 1, 2026/ })).toHaveFocus();
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(screen.getByRole('button', { name: /November 24, 2026/ })).toHaveFocus();
    fireEvent.keyDown(grid, { key: 'PageDown', shiftKey: true });
    expect(screen.getByRole('grid', { name: 'November 2027' })).toBeInTheDocument();
  });
});
