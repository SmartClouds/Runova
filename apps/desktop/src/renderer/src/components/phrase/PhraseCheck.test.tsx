import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PhraseCheck, pickCheck } from './PhraseCheck';

const WORDS =
  'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'.split(
    ' ',
  );

describe('pickCheck', () => {
  it('asks for three different places, in order, each with four different words', () => {
    for (let run = 0; run < 50; run++) {
      const questions = pickCheck(WORDS);
      expect(questions).toHaveLength(3);
      const places = questions.map((q) => q.place);
      expect(new Set(places).size).toBe(3);
      expect([...places].sort((a, b) => a - b)).toEqual(places);
      for (const q of questions) {
        expect(q.choices).toHaveLength(4);
        expect(new Set(q.choices).size).toBe(4);
        expect(q.choices).toContain(WORDS[q.place]);
      }
    }
  });

  it('never offers a decoy that is also the right word in another spelling of the phrase', () => {
    // "private" is word 3 and word 7, "delay" is word 6 and 23: a decoy equal to the answer
    // would make two right buttons.
    for (let run = 0; run < 50; run++) {
      for (const q of pickCheck(WORDS)) {
        expect(q.choices.filter((c) => c === WORDS[q.place])).toHaveLength(1);
      }
    }
  });
});

describe('PhraseCheck', () => {
  const questions = [
    { place: 2, choices: ['zoo', 'private', 'abandon', 'cable'] },
    { place: 9, choices: ['toddler', 'zebra', 'fancy', 'apple'] },
    { place: 20, choices: ['ability', 'pull', 'shrug', 'ocean'] },
  ];

  it('asks for each word by its number and passes after three right answers', () => {
    const onPassed = vi.fn();
    render(
      <PhraseCheck words={WORDS} questions={questions} onPassed={onPassed} onBack={vi.fn()} />,
    );

    expect(screen.getByText('Which is word 3?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'private' }));
    expect(screen.getByText('Which is word 10?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'toddler' }));
    fireEvent.click(screen.getByRole('button', { name: 'shrug' }));

    expect(onPassed).toHaveBeenCalledTimes(1);
  });

  it('stays on a question after a wrong answer and says why', () => {
    const onPassed = vi.fn();
    render(
      <PhraseCheck words={WORDS} questions={questions} onPassed={onPassed} onBack={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'zoo' }));

    expect(screen.getByRole('alert')).toHaveTextContent('That is not word 3');
    expect(screen.getByText('Which is word 3?')).toBeInTheDocument();
    expect(onPassed).not.toHaveBeenCalled();
  });

  it('goes back to the words', () => {
    const onBack = vi.fn();
    render(<PhraseCheck words={WORDS} questions={questions} onPassed={vi.fn()} onBack={onBack} />);

    fireEvent.click(screen.getByRole('button', { name: /Show the words again/ }));

    expect(onBack).toHaveBeenCalled();
  });
});
