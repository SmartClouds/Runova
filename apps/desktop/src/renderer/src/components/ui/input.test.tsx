import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox } from './combobox';
import { Input } from './input';
import { SecretInput } from './secret-input';
import { Textarea } from './textarea';

// The tests only look at classes, so a change goes nowhere.
const ignore = (): void => undefined;

function ControlledNumber({ initial, min, max }: { initial: string; min?: number; max?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <Input
      aria-label="Count"
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

describe('shared field surface', () => {
  it('draws Input, Textarea and the Combobox trigger with the field surface by default', () => {
    render(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
        <Combobox ariaLabel="Model" options={[]} value="" onChange={ignore} />
      </>,
    );
    expect(screen.getByLabelText('Name')).toHaveClass('field-surface', 'rounded-full');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveClass(
      'field-surface',
      'rounded-full',
    );
    // A multi-line box keeps the surface but not the pill shape.
    const notes = screen.getByLabelText('Notes');
    expect(notes).toHaveClass('field-surface');
    expect(notes).not.toHaveClass('rounded-full');
  });

  it('draws a number field on its shell, which holds the step buttons too', () => {
    render(<Input aria-label="Port" type="number" />);
    const port = screen.getByLabelText('Port');
    expect(port).not.toHaveClass('field-surface');
    expect(port.parentElement).toHaveClass('field-surface', 'rounded-full');
  });

  it('steps a controlled number field once per press and keeps stepping while held', () => {
    vi.useFakeTimers();
    try {
      render(<ControlledNumber initial="5" max={100} />);
      const field = screen.getByLabelText('Count');
      const up = screen.getByRole('button', { name: 'Increase value' });

      fireEvent.pointerDown(up, { button: 0 });
      expect(field).toHaveValue(6);
      act(() => vi.advanceTimersByTime(399));
      expect(field).toHaveValue(6);
      act(() => vi.advanceTimersByTime(1 + 60 * 3));
      expect(field).toHaveValue(10);

      fireEvent.pointerUp(window);
      act(() => vi.advanceTimersByTime(1000));
      expect(field).toHaveValue(10);
      // The press already stepped, so the click that follows it must not step again.
      fireEvent.click(up, { detail: 1 });
      expect(field).toHaveValue(10);

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Decrease value' }), { button: 0 });
      fireEvent.pointerLeave(screen.getByRole('button', { name: 'Decrease value' }));
      act(() => vi.advanceTimersByTime(1000));
      expect(field).toHaveValue(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('steps on a click that has no pointer behind it, as assistive tech sends', () => {
    render(<ControlledNumber initial="1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Increase value' }), { detail: 0 });
    expect(screen.getByLabelText('Count')).toHaveValue(2);
  });

  it('disables the step that would pass a bound and stops a hold that reaches it', () => {
    vi.useFakeTimers();
    try {
      render(<ControlledNumber initial="8" min={0} max={10} />);
      const up = screen.getByRole('button', { name: 'Increase value' });
      fireEvent.pointerDown(up, { button: 0 });
      act(() => vi.advanceTimersByTime(2000));
      expect(screen.getByLabelText('Count')).toHaveValue(10);
      expect(up).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Decrease value' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the step buttons from a disabled or read-only number field', () => {
    render(
      <>
        <Input aria-label="Off" type="number" disabled />
        <Input aria-label="Fixed" type="number" readOnly />
      </>,
    );
    expect(screen.queryByRole('button', { name: 'Increase value' })).toBeNull();
  });

  it('gives a secret field the surface too', () => {
    render(<SecretInput aria-label="Key" value="" onChange={ignore} />);
    expect(screen.getByLabelText('Key')).toHaveClass('field-surface');
  });

  it('drops the surface for the bare variant without passing the variant to the DOM', () => {
    render(
      <>
        <Input aria-label="Bare" variant="bare" />
        <Textarea aria-label="Bare notes" variant="bare" />
        <Combobox ariaLabel="Bare pick" variant="bare" options={[]} value="" onChange={ignore} />
      </>,
    );
    expect(screen.getByLabelText('Bare')).not.toHaveClass('field-surface');
    expect(screen.getByLabelText('Bare')).not.toHaveAttribute('variant');
    expect(screen.getByLabelText('Bare notes')).not.toHaveClass('field-surface');
    expect(screen.getByRole('combobox', { name: 'Bare pick' })).not.toHaveClass('field-surface');
  });

  it('marks a rejected combobox value as invalid', () => {
    render(<Combobox ariaLabel="Region" invalid options={[]} value="" onChange={ignore} />);
    expect(screen.getByRole('combobox', { name: 'Region' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});
