import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { ExistingSecretField } from './ExistingSecretField';

const WORDS =
  'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'.split(
    ' ',
  );
const seen = vi.fn();

function Harness() {
  const [value, setValue] = useState('');
  seen(value);
  return <ExistingSecretField id="s" label="Secret key" value={value} onChange={setValue} />;
}

beforeEach(() => {
  seen.mockReset();
  Object.assign(window, { runova: createRunovaBridge() });
});

describe('ExistingSecretField', () => {
  it('is a masked field for a typed secret', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'typed by hand' } });

    expect(seen).toHaveBeenLastCalledWith('typed by hand');
  });

  it('turns into word boxes when a phrase is pasted, and hands over the words', () => {
    render(<Harness />);

    fireEvent.paste(screen.getByLabelText('Secret key'), {
      clipboardData: { getData: () => WORDS.join('\n') },
    });

    expect(screen.getByRole('textbox', { name: 'Word 24' })).toHaveValue('length');
    expect(seen).toHaveBeenLastCalledWith(WORDS.join(' '));
  });

  it('switches both ways on request and starts empty each time', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'half typed' } });

    fireEvent.click(screen.getByRole('button', { name: 'It is a recovery phrase' }));
    expect(screen.getByRole('textbox', { name: 'Word 1' })).toBeInTheDocument();
    expect(seen).toHaveBeenLastCalledWith('');

    fireEvent.click(screen.getByRole('button', { name: 'Type it instead' }));
    expect(screen.getByLabelText('Secret key')).toHaveValue('');
  });
});
