import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SimpleTooltip, TooltipProvider } from './tooltip';

function show(label: React.ReactNode, ariaLabel?: string) {
  const user = userEvent.setup();
  render(
    <TooltipProvider delayDuration={0}>
      <SimpleTooltip label={label} ariaLabel={ariaLabel}>
        <button type="button">Trigger</button>
      </SimpleTooltip>
    </TooltipProvider>,
  );
  return user.hover(screen.getByRole('button', { name: 'Trigger' }));
}

describe('SimpleTooltip', () => {
  it('describes its trigger with the label', async () => {
    await show('Saved two minutes ago');
    expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent(
      'Saved two minutes ago',
    );
  });

  it('reads out a plain summary instead of copying a rich label a second time', async () => {
    await show(
      <span>
        <span>Fix login redirect</span>
        <button type="button">Details</button>
      </span>,
      'Fix login redirect, context 42% used',
    );

    expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent(
      'Fix login redirect, context 42% used',
    );
    // The visible bubble is the only copy of the label, so its controls exist once. (jsdom never
    // positions the bubble, so it stays visibility: hidden and is found by text, not by role.)
    expect(screen.getAllByText('Details', { selector: 'button' })).toHaveLength(1);
  });
});
