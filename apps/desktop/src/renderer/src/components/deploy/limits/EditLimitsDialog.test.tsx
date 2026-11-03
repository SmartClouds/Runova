import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditLimitsDialog } from './EditLimitsDialog';

/** Changing the limits of an app or a container after it was made. */

const HOST = { cores: 4, memoryMb: 8192, diskLimits: true };

function renderDialog(props: Partial<React.ComponentProps<typeof EditLimitsDialog>> = {}) {
  const onSave = vi.fn();
  const onOpenChange = vi.fn();
  const view = render(
    <EditLimitsDialog
      open
      onOpenChange={onOpenChange}
      services={['web', 'db']}
      initial={[{ service: 'db', memoryMb: 2048 }]}
      host={HOST}
      busy={false}
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave, onOpenChange, ...view };
}

describe('EditLimitsDialog', () => {
  it('opens on the saved limits', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Edit resource limits' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'db' })).getByText('2 GB RAM'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The services whose limits change restart to apply them.'),
    ).toBeInTheDocument();
  });

  it('saves only once something changed', async () => {
    const { onSave } = renderDialog();
    const save = screen.getByRole('button', { name: 'Save limits' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited CPU for web' }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledWith([
      { service: 'web', cpuCores: 2, cpuPercent: 100 },
      { service: 'db', memoryMb: 2048 },
    ]);
  });

  it('can take every limit away', async () => {
    const { onSave } = renderDialog();
    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited memory for db' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(onSave).toHaveBeenCalledWith([]);
  });

  it('holds Save while saving and shows what went wrong', () => {
    renderDialog({ busy: true, error: 'The server has 4 cores, so it cannot give 8.' });
    expect(screen.getByRole('button', { name: /Sav/ })).toBeDisabled();
    expect(screen.getByText('The server has 4 cores, so it cannot give 8.')).toBeInTheDocument();
  });

  it('says a live edit applies at once but is lost with the container', () => {
    renderDialog({ services: ['web'], initial: [], cpuOnlyLive: true });
    expect(
      screen.getByText(
        'These apply right away without a restart. Whatever recreates this container drops them.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Unlimited disk for web' }),
    ).not.toBeInTheDocument();
  });

  it('starts over from the saved limits each time it opens', async () => {
    const { rerender, onSave } = renderDialog();
    fireEvent.click(screen.getByRole('switch', { name: 'Unlimited memory for db' }));
    const props = {
      onOpenChange: vi.fn(),
      services: ['web', 'db'],
      initial: [{ service: 'db', memoryMb: 2048 }],
      host: HOST,
      busy: false,
      onSave,
    };
    rerender(<EditLimitsDialog open={false} {...props} />);
    rerender(<EditLimitsDialog open {...props} />);
    expect(
      within(screen.getByRole('region', { name: 'db' })).getByText('2 GB RAM'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
  });

  it('closes with Cancel', async () => {
    const { onOpenChange } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('marks the service it was opened for', () => {
    renderDialog({ focus: 'db' });
    expect(screen.getByRole('region', { name: 'db' })).toHaveAttribute('data-focused', 'true');
  });
});
