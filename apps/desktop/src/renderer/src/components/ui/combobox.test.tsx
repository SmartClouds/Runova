import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Combobox } from './combobox';

const POLICIES = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
  { value: 'reject', label: 'Reject' },
];

describe('Combobox', () => {
  it('opens with a search box by default', async () => {
    const user = userEvent.setup();
    render(<Combobox ariaLabel="Policy" options={POLICIES} value="deny" onChange={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: 'Policy' }));
    expect(await screen.findByPlaceholderText('Search…')).toHaveFocus();
  });

  it('drops the search box for a short list and still works from the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Combobox
        ariaLabel="Policy"
        searchable={false}
        options={POLICIES}
        value="deny"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Policy' }));
    expect(await screen.findByRole('option', { name: 'Deny' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByPlaceholderText('Search…')).toBeNull();

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('reject');
  });

  it('shows a hint beside an option and finds the option by it', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        ariaLabel="Network"
        options={[
          { value: 'shop', label: 'shop_default', hint: '172.20.0.0/16' },
          { value: 'tools', label: 'tools_net', hint: '10.9.0.0/24' },
        ]}
        value=""
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Network' }));
    expect(await screen.findByText('172.20.0.0/16')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Search…'), '10.9');
    expect(screen.getByRole('option', { name: /tools_net/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /shop_default/ })).toBeNull();
  });

  it('leaves focus where a choice moved it, even when it moved before the list closed', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Combobox
          ariaLabel="Policy"
          options={POLICIES}
          value="deny"
          // A timer queued before the list closes, as a frame callback is on a busy machine
          // (NewVideoDialog's custom style box, CI run #444).
          onChange={() => setTimeout(() => screen.getByLabelText('Reason').focus(), 0)}
        />
        <input aria-label="Reason" />
      </>,
    );

    await user.click(screen.getByRole('combobox', { name: 'Policy' }));
    await user.click(await screen.findByRole('option', { name: 'Reject' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByLabelText('Reason')).toHaveFocus();
  });

  it('gives focus back to the field after a choice that moves it nowhere', async () => {
    const user = userEvent.setup();
    render(<Combobox ariaLabel="Policy" options={POLICIES} value="deny" onChange={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: 'Policy' }));
    await user.click(await screen.findByRole('option', { name: 'Reject' }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Policy' })).toHaveFocus());
  });
});
