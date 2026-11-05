import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CleanupActionBar, type CleanupActionBarProps } from './CleanupActionBar';

const GB = 1024 ** 3;

function bar(over: Partial<CleanupActionBarProps> = {}): CleanupActionBarProps {
  return {
    count: 3,
    freeBytes: 1.2 * GB,
    removing: false,
    progress: null,
    onDelete: vi.fn(),
    onClear: vi.fn(),
    ...over,
  };
}

describe('CleanupActionBar', () => {
  it('stays out of the way until something is picked', () => {
    const { container } = renderWithProviders(<CleanupActionBar {...bar({ count: 0 })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says how many are picked and how much deleting them frees', () => {
    renderWithProviders(<CleanupActionBar {...bar()} />);
    expect(screen.getByText('3 items selected')).toBeInTheDocument();
    expect(screen.getByText(/frees 1\.20 GB/i)).toBeInTheDocument();
  });

  it('says "1 item" for one', () => {
    renderWithProviders(<CleanupActionBar {...bar({ count: 1 })} />);
    expect(screen.getByText('1 item selected')).toBeInTheDocument();
  });

  it('puts the size on the delete button so the person knows what it will do', () => {
    renderWithProviders(<CleanupActionBar {...bar()} />);
    expect(screen.getByRole('button', { name: 'Delete 1.20 GB' })).toBeInTheDocument();
  });

  it('asks the page to delete, or to clear the picks', async () => {
    const props = bar();
    const { user } = renderWithProviders(<CleanupActionBar {...props} />);
    await user.click(screen.getByRole('button', { name: 'Delete 1.20 GB' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it('shows how far the deletion has got and cannot be clicked again', () => {
    renderWithProviders(
      <CleanupActionBar {...bar({ removing: true, progress: { done: 1, total: 3 } })} />,
    );
    expect(screen.getByText('1 of 3 deleted')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: /deleting/i });
    expect(progress).toHaveAttribute('aria-valuenow', '1');
    expect(progress).toHaveAttribute('aria-valuemax', '3');
    expect(screen.getByRole('button', { name: /deleting/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });

  it('stays on screen while deleting, even as the picks are emptied one by one', () => {
    renderWithProviders(
      <CleanupActionBar {...bar({ count: 0, removing: true, progress: { done: 3, total: 3 } })} />,
    );
    expect(screen.getByText('3 of 3 deleted')).toBeInTheDocument();
  });

  it('is a toolbar a keyboard can reach', () => {
    renderWithProviders(<CleanupActionBar {...bar()} />);
    expect(screen.getByRole('region', { name: /selected folders/i })).toBeInTheDocument();
  });
});
