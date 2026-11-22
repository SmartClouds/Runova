import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DatePicker } from './date-picker';

function Harness({ initial, clearable }: { initial: string; clearable?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <DatePicker
      aria-label="Expires"
      value={value}
      onChange={setValue}
      placeholder="Never"
      {...(clearable ? { clearable } : {})}
    />
  );
}

describe('DatePicker', () => {
  it('shows the day in words and swaps it for the one picked in the calendar', async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-11-16" />);
    const field = screen.getByRole('button', { name: 'Expires' });
    expect(field).toHaveTextContent('Nov 16, 2026');

    await user.click(field);
    await user.click(await screen.findByRole('button', { name: /November 20, 2026/ }));
    expect(field).toHaveTextContent('Nov 20, 2026');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('goes back to empty with Clear when it allows that', async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-11-16" clearable />);
    const field = screen.getByRole('button', { name: 'Expires' });
    await user.click(field);
    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(field).toHaveTextContent('Never');
  });
});
