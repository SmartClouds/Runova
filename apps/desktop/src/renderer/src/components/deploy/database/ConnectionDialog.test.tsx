import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ConnectionDialog } from './ConnectionDialog';

/** Adding a connection from one pasted URL, with what was read from it shown before saving. */

function renderDialog(bridge: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  const view = renderWithProviders(
    <ConnectionDialog open server={null} onOpenChange={vi.fn()} onSaved={onSaved} />,
    { bridge },
  );
  return { ...view, onSaved };
}

function urlField(): HTMLInputElement {
  return screen.getByLabelText('Connection URL') as HTMLInputElement;
}

describe('ConnectionDialog', () => {
  it('shows an engine example in the field when its mark is picked', async () => {
    const view = renderDialog();
    expect(urlField()).toHaveAttribute('placeholder', expect.stringMatching(/^postgres:\/\//));
    await view.user.click(screen.getByRole('button', { name: 'Show a Redis example' }));
    expect(urlField()).toHaveAttribute('placeholder', expect.stringMatching(/^redis:\/\//));
    expect(urlField()).toHaveFocus();
  });

  it('reads the URL back before anything connects', () => {
    renderDialog();
    fireEvent.change(urlField(), {
      target: { value: 'postgres://app:secret@db.example.com:6543/shop?sslmode=require' },
    });
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('db.example.com:6543')).toBeInTheDocument();
    expect(screen.getByText('Encrypted')).toBeInTheDocument();
    expect(screen.getByText('shop')).toBeInTheDocument();
    expect(screen.getByText('Included')).toBeInTheDocument();
    expect(screen.queryByText(/usually needs a password/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and connect' })).toBeEnabled();
  });

  it('warns when an engine that needs a password has none in the URL', () => {
    renderDialog();
    fireEvent.change(urlField(), { target: { value: 'mysql://root@localhost/shop' } });
    expect(screen.getByText(/MySQL usually needs a password/)).toBeInTheDocument();
  });

  it('marks the field invalid and keeps saving off for a URL it cannot read', () => {
    renderDialog();
    fireEvent.change(urlField(), { target: { value: 'not a url' } });
    expect(urlField()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/This is not a database URL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and connect' })).toBeDisabled();
  });

  it('shows why a save failed', async () => {
    const view = renderDialog({
      'database.saveConnection': async () => {
        throw new Error('Could not reach db.example.com:5432');
      },
    });
    fireEvent.change(urlField(), { target: { value: 'postgres://app:pw@db.example.com/shop' } });
    await view.user.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach/);
    expect(view.onSaved).not.toHaveBeenCalled();
  });
});
