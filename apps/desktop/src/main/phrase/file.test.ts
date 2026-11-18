import { describe, expect, it } from 'vitest';
import { phraseFileName, phraseFileText, readPhraseFile } from './file';

/** The text file a recovery phrase is saved to, and reading one back to unlock (E107). */

const PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
const MADE = new Date('2026-11-18T10:30:00Z');

describe('phraseFileText', () => {
  const text = phraseFileText({ purpose: 'vault', label: 'Vault', phrase: PHRASE, made: MADE });

  it('says what the phrase opens, and when it was made', () => {
    expect(text).toMatch(/^Runova recovery phrase\r?\n/);
    expect(text).toContain('Opens: Your Runova Vault');
    expect(text).toContain('Name: Vault');
    expect(text).toContain('Made: 2026-11-18');
  });

  it('numbers all 24 words in rows of four', () => {
    expect(text).toMatch(/ 1\. legal\s+2\. winner\s+3\. thank\s+4\. year/);
    expect(text).toMatch(/21\. wave\s+22\. sausage\s+23\. worth\s+24\. title/);
  });

  it('warns that the file opens the data, and holds nothing else secret', () => {
    expect(text).toContain('Anyone who has these words');
    expect(text.split(/\s+/).filter((w) => w === 'legal')).toHaveLength(3);
  });

  it('uses Windows line breaks on Windows so Notepad shows the rows', () => {
    expect(
      phraseFileText({ purpose: 'sync', label: 'x', phrase: PHRASE, made: MADE }, 'win32'),
    ).toContain('\r\n');
    expect(
      phraseFileText({ purpose: 'sync', label: 'x', phrase: PHRASE, made: MADE }, 'linux'),
    ).not.toContain('\r');
  });

  it('refuses words that are not a phrase', () => {
    expect(() =>
      phraseFileText({ purpose: 'sync', label: 'x', phrase: 'hello there', made: MADE }),
    ).toThrow();
  });
});

describe('readPhraseFile', () => {
  it('reads back a file it wrote, on any platform', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const text = phraseFileText(
        { purpose: 'sync-recovery', label: 'Personal', phrase: PHRASE, made: MADE },
        platform,
      );
      expect(readPhraseFile(text)).toBe(PHRASE);
    }
  });

  it('reads a file that holds only the words', () => {
    expect(readPhraseFile(`${PHRASE.toUpperCase()}\n`)).toBe(PHRASE);
  });

  it('reads a numbered list in any order of rows', () => {
    const words = PHRASE.split(' ');
    const lines = words.map((w, i) => `${i + 1}) ${w}`).reverse();
    expect(readPhraseFile(lines.join('\n'))).toBe(PHRASE);
  });

  it('finds nothing in a file without a phrase, or with a wrong word', () => {
    expect(readPhraseFile('my shopping list\n1. milk\n2. eggs')).toBeNull();
    expect(readPhraseFile(PHRASE.replace('title', 'zoo'))).toBeNull();
    expect(readPhraseFile('')).toBeNull();
  });
});

describe('phraseFileName', () => {
  it('names the file after what it opens and the day, without characters a disk refuses', () => {
    expect(phraseFileName('Team: web/ops?', MADE)).toBe(
      'Runova recovery phrase - Team web ops - 2026-11-18.txt',
    );
    expect(phraseFileName('', MADE)).toBe('Runova recovery phrase - 2026-11-18.txt');
  });
});
