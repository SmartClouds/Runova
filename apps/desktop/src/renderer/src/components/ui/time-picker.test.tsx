import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TimePicker } from './time-picker';

function Harness({ initial, hourCycle }: { initial: string; hourCycle: 12 | 24 }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TimePicker aria-label="Time" value={value} onChange={setValue} hourCycle={hourCycle} />
      <output data-testid="value">{value}</output>
    </>
  );
}

const value = () => screen.getByTestId('value');

describe('TimePicker', () => {
  it('shows the time the way the clock reads', () => {
    const { unmount } = render(<Harness initial="03:00" hourCycle={12} />);
    expect(screen.getByRole('button', { name: 'Time' })).toHaveTextContent('3:00 AM');
    unmount();
    render(<Harness initial="22:30" hourCycle={24} />);
    expect(screen.getByRole('button', { name: 'Time' })).toHaveTextContent('22:30');
  });

  it('opens on the current hour, minute and half of the day', async () => {
    const user = userEvent.setup();
    render(<Harness initial="15:20" hourCycle={12} />);
    await user.click(screen.getByRole('button', { name: 'Time' }));
    const hours = await screen.findByRole('listbox', { name: 'Hour' });
    expect(within(hours).getByRole('option', { name: '3' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      within(screen.getByRole('listbox', { name: 'Minute' })).getByRole('option', { name: '20' }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      within(screen.getByRole('listbox', { name: 'AM or PM' })).getByRole('option', {
        name: 'PM',
      }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('sets the time from the picked hour, minute and half of the day', async () => {
    const user = userEvent.setup();
    render(<Harness initial="03:00" hourCycle={12} />);
    const field = screen.getByRole('button', { name: 'Time' });
    await user.click(field);
    await user.click(
      within(await screen.findByRole('listbox', { name: 'Hour' })).getByRole('option', {
        name: '10',
      }),
    );
    await user.click(
      within(screen.getByRole('listbox', { name: 'Minute' })).getByRole('option', { name: '30' }),
    );
    await user.click(
      within(screen.getByRole('listbox', { name: 'AM or PM' })).getByRole('option', {
        name: 'PM',
      }),
    );
    expect(value()).toHaveTextContent('22:30');
    expect(field).toHaveTextContent('10:30 PM');
  });

  it('reads 12 AM as midnight', async () => {
    const user = userEvent.setup();
    render(<Harness initial="03:00" hourCycle={12} />);
    await user.click(screen.getByRole('button', { name: 'Time' }));
    await user.click(
      within(await screen.findByRole('listbox', { name: 'Hour' })).getByRole('option', {
        name: '12',
      }),
    );
    expect(value()).toHaveTextContent('00:00');
  });

  it('lists all 24 hours and no AM or PM on a 24-hour clock', async () => {
    const user = userEvent.setup();
    render(<Harness initial="03:00" hourCycle={24} />);
    await user.click(screen.getByRole('button', { name: 'Time' }));
    const hours = await screen.findByRole('listbox', { name: 'Hour' });
    expect(within(hours).getAllByRole('option')).toHaveLength(24);
    expect(screen.queryByRole('listbox', { name: 'AM or PM' })).not.toBeInTheDocument();
    await user.click(within(hours).getByRole('option', { name: '18' }));
    expect(value()).toHaveTextContent('18:00');
  });

  it('keeps a saved minute that falls between the steps', async () => {
    const user = userEvent.setup();
    render(<Harness initial="04:07" hourCycle={24} />);
    await user.click(screen.getByRole('button', { name: 'Time' }));
    const minutes = await screen.findByRole('listbox', { name: 'Minute' });
    expect(within(minutes).getByRole('option', { name: '07' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('moves through a column with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Harness initial="11:00" hourCycle={24} />);
    await user.click(screen.getByRole('button', { name: 'Time' }));
    const hours = await screen.findByRole('listbox', { name: 'Hour' });
    within(hours).getByRole('option', { name: '11' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(value()).toHaveTextContent('12:00');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(value()).toHaveTextContent('10:00');
    await user.keyboard('{End}');
    expect(value()).toHaveTextContent('23:00');
    await user.keyboard('{ArrowDown}');
    expect(value()).toHaveTextContent('00:00');
  });

  it('closes with Done', async () => {
    const user = userEvent.setup();
    render(<Harness initial="03:00" hourCycle={12} />);
    await user.click(screen.getByRole('button', { name: 'Time' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('listbox', { name: 'Hour' })).not.toBeInTheDocument();
  });
});
