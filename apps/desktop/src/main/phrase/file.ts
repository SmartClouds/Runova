import {
  canonicalSecret,
  isValidPhrase,
  PHRASE_WORD_COUNT,
  type PhrasePurpose,
} from '@runova/protocol';

/**
 * The text file a recovery phrase is saved to (E107): what it opens, when it was made, the numbered
 * words, and a warning. Nothing else goes in it. `readPhraseFile` reads one back so an unlock
 * field can be filled from it.
 */

export const PHRASE_OPENS: Record<PhrasePurpose, string> = {
  sync: 'Your synced data (the sync key)',
  'sync-recovery': 'Your synced data, if the passphrase is lost (the recovery key)',
  vault: 'Your Runova Vault',
  'server-backup': 'The backups of a server (its secret key)',
  'app-backup': 'The environment values in a Runova settings backup',
  'servers-passkey': 'The saved server sign-ins on this computer (the servers passkey)',
};

const COLUMNS = 4;

const day = (date: Date) => date.toISOString().slice(0, 10);

export function phraseFileText(
  input: { purpose: PhrasePurpose; label: string; phrase: string; made: Date },
  platform: NodeJS.Platform = process.platform,
): string {
  if (!isValidPhrase(input.phrase)) throw new Error('That is not a recovery phrase.');
  const words = canonicalSecret(input.phrase).split(' ');
  const width = Math.max(...words.map((w) => w.length));
  const rows: string[] = [];
  for (let i = 0; i < words.length; i += COLUMNS) {
    rows.push(
      words
        .slice(i, i + COLUMNS)
        .map((word, j) => `${String(i + j + 1).padStart(2, ' ')}. ${word.padEnd(width, ' ')}`)
        .join('   ')
        .trimEnd(),
    );
  }
  const lines = [
    'Runova recovery phrase',
    '',
    `Opens: ${PHRASE_OPENS[input.purpose]}`,
    `Name: ${input.label.replace(/[\r\n]+/g, ' ')}`,
    `Made: ${day(input.made)}`,
    '',
    ...rows,
    '',
    'Anyone who has these words can open what they protect.',
    'Keep this file where only you can reach it, such as a password manager or an encrypted drive,',
    'or print it and delete the file. Runova can not show these words again or reset them for you.',
    '',
  ];
  return lines.join(platform === 'win32' ? '\r\n' : '\n');
}

/** The phrase in a saved file, a numbered list, or a file of just the words. Null if none. */
export function readPhraseFile(text: string): string | null {
  const numbered = new Map<number, string>();
  for (const match of text.matchAll(/(?:^|\s)(\d{1,2})[.)]\s*([A-Za-z]+)/g)) {
    numbered.set(Number(match[1]), match[2] as string);
  }
  if (numbered.size === PHRASE_WORD_COUNT) {
    const words = Array.from({ length: PHRASE_WORD_COUNT }, (_, i) => numbered.get(i + 1));
    if (words.every(Boolean)) {
      const joined = words.join(' ');
      if (isValidPhrase(joined)) return canonicalSecret(joined);
    }
  }
  return isValidPhrase(text) ? canonicalSecret(text) : null;
}

export function phraseFileName(label: string, made: Date): string {
  const clean = label
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return ['Runova recovery phrase', clean, day(made)].filter(Boolean).join(' - ') + '.txt';
}
