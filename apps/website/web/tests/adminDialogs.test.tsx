// @vitest-environment jsdom
import './setup/dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from '../src/components/admin/ConfirmButton';
import { CopyField } from '../src/components/admin/CopyField';
import { SecretDialog } from '../src/components/admin/SecretDialog';
import { SECRET } from './fixtures/admin/staff';

function stubClipboard(writeText = vi.fn(async (_text: string) => undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('SecretDialog', () => {
  it('shows the key id, the secret and a warning that it is shown only this once', () => {
    render(<SecretDialog open keyId="rk_5f2c9a1e7b3d4c60" secret={SECRET} onDone={() => {}} />);

    const dialog = screen.getByRole('alertdialog', { name: 'Copy the secret now' });
    expect(dialog).toHaveTextContent('rk_5f2c9a1e7b3d4c60');
    expect(screen.getByLabelText('Secret')).toHaveValue(SECRET);
    expect(screen.getByLabelText('Secret')).toHaveAttribute('readonly');
    expect(dialog).toHaveTextContent(/only time/i);
  });

  it('copies the secret with the copy button and says so', async () => {
    const user = userEvent.setup();
    render(<SecretDialog open keyId="rk_5f2c9a1e7b3d4c60" secret={SECRET} onDone={() => {}} />);
    const writeText = stubClipboard();

    await user.click(screen.getByRole('button', { name: 'Copy secret' }));

    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(screen.getByRole('status')).toHaveTextContent('Copied.');
  });

  it('stays open on Escape and closes only with the button, after which the secret is gone', async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <SecretDialog open keyId="rk_5f2c9a1e7b3d4c60" secret={SECRET} onDone={onDone} />,
    );

    await user.keyboard('{Escape}');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'I have saved the secret' }));
    expect(onDone).toHaveBeenCalledOnce();

    rerender(<SecretDialog open={false} keyId="" secret="" onDone={onDone} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.body).not.toHaveTextContent(SECRET);
  });
});

describe('CopyField', () => {
  it('asks to copy by hand and selects the text when the clipboard refuses', async () => {
    const user = userEvent.setup();
    render(<CopyField id="link" label="Invitation link" value="https://example.test/x" />);
    stubClipboard(vi.fn(async () => Promise.reject(new Error('denied'))));

    await user.click(screen.getByRole('button', { name: 'Copy invitation link' }));

    expect(screen.getByRole('status')).toHaveTextContent(/copy it by hand/i);
    const input = screen.getByLabelText('Invitation link') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  });
});

describe('ConfirmButton', () => {
  const setup = (onConfirm = vi.fn()) => {
    render(
      <ConfirmButton
        label="Revoke"
        title="Revoke Advisory importer?"
        description="Its signed requests stop working at once."
        confirmLabel="Revoke client"
        onConfirm={onConfirm}
      />,
    );
    return onConfirm;
  };

  it('asks first, and Cancel does nothing', async () => {
    const user = userEvent.setup();
    const onConfirm = setup();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke Advisory importer?' });
    expect(dialog).toHaveTextContent('Its signed requests stop working at once.');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revoke' }));
  });

  it('runs the action once it is confirmed', async () => {
    const user = userEvent.setup();
    const onConfirm = setup();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Revoke client' }));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('can carry a field inside the dialog, such as how long the old key keeps working', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmButton
        label="Rotate secret"
        title="Rotate the secret?"
        description="A new secret replaces the current one."
        confirmLabel="Rotate"
        onConfirm={() => {}}
      >
        <label>
          Overlap <input />
        </label>
      </ConfirmButton>,
    );

    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));

    expect(screen.getByRole('alertdialog')).toContainElement(screen.getByLabelText('Overlap'));
  });
});
