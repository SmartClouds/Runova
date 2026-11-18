import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunovaBridge, type FakeBridge } from '../../../../test/renderer/runovaBridge';
import { PhraseInput } from './PhraseInput';

const PHRASE =
  'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length';
const WORDS = PHRASE.split(' ');

let bridge: FakeBridge;
const cell = (n: number) => screen.getByRole('textbox', { name: `Word ${n}` });

beforeEach(() => {
  bridge = createRunovaBridge({ 'phrase.open': { phrase: PHRASE } });
  Object.assign(window, { runova: bridge });
});

describe('PhraseInput', () => {
  it('fills all 24 boxes from one paste, numbered list or not, and says the words check out', () => {
    const onChange = vi.fn();
    render(<PhraseInput onChange={onChange} />);

    fireEvent.paste(cell(1), {
      clipboardData: { getData: () => WORDS.map((w, i) => `${i + 1}. ${w}`).join('\n') },
    });

    expect(cell(1)).toHaveValue('hamster');
    expect(cell(24)).toHaveValue('length');
    expect(onChange).toHaveBeenLastCalledWith(PHRASE);
    expect(screen.getByText('The words check out')).toBeInTheDocument();
  });

  it('marks a word that is not on the list once you leave its box', () => {
    render(<PhraseInput onChange={vi.fn()} />);

    fireEvent.change(cell(1), { target: { value: 'hamsterz' } });
    expect(cell(1)).not.toHaveAttribute('aria-invalid', 'true');
    fireEvent.blur(cell(1));

    expect(cell(1)).toHaveAttribute('aria-invalid', 'true');
  });

  it('says so when every word is real but they do not make a phrase', () => {
    render(<PhraseInput onChange={vi.fn()} />);

    fireEvent.paste(cell(1), {
      clipboardData: { getData: () => [...WORDS.slice(0, 23), 'zoo'].join(' ') },
    });

    expect(screen.getByText(/not a recovery phrase/)).toBeInTheDocument();
  });

  it('suggests the word as you type, and Tab or space takes it and moves on', () => {
    render(<PhraseInput onChange={vi.fn()} />);
    cell(1).focus();

    fireEvent.change(cell(1), { target: { value: 'hams' } });
    expect(screen.getByText('hamster', { selector: '[data-suggestion]' })).toBeInTheDocument();
    fireEvent.keyDown(cell(1), { key: 'Tab' });
    expect(cell(1)).toHaveValue('hamster');
    expect(cell(2)).toHaveFocus();

    fireEvent.change(cell(2), { target: { value: 'diag' } });
    fireEvent.keyDown(cell(2), { key: ' ' });
    expect(cell(2)).toHaveValue('diagram');
    expect(cell(3)).toHaveFocus();
  });

  it('goes back a box with Backspace in an empty one', () => {
    render(<PhraseInput onChange={vi.fn()} />);
    cell(2).focus();

    fireEvent.keyDown(cell(2), { key: 'Backspace' });

    expect(cell(1)).toHaveFocus();
  });

  it('fills the boxes from a saved phrase file', async () => {
    const onChange = vi.fn();
    render(<PhraseInput onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Open a saved file/ }));

    await waitFor(() => expect(cell(24)).toHaveValue('length'));
    expect(onChange).toHaveBeenLastCalledWith(PHRASE);
  });

  it('starts from a phrase it is given, such as one pasted in a password box', () => {
    render(<PhraseInput onChange={vi.fn()} initial={PHRASE.toUpperCase()} />);

    expect(cell(3)).toHaveValue('private');
  });
});
