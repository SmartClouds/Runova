import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyHelpFilter, HELP_FILTER, unusedFilterRules } from '../src/lib/help/filter';
import { forbiddenPhrases } from './helpers/textScan';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/help/${name}`, import.meta.url), 'utf8');
}

function article(name: string): string {
  return readFileSync(
    new URL(`../../../desktop/src/shared/help/articles/${name}`, import.meta.url),
    'utf8',
  );
}

function forbiddenIn(text: string): string[] {
  const lower = text.toLowerCase();
  return forbiddenPhrases().filter((phrase) => lower.includes(phrase));
}

describe('the help filter on a fixture with a phone pairing section', () => {
  const filtered = applyHelpFilter('remote.md', fixture('remote.md'));

  it('replaces the summary', () => {
    expect(filtered).toMatch(
      /^summary: Control another Runova over your network, connect to servers over SSH, and open Windows Remote Desktop sessions\.$/m,
    );
  });

  it('drops the mobile keywords and keeps the rest in order', () => {
    expect(filtered).toMatch(/^keywords: remote, ssh, host, pairing code, qr code, rdp, lan$/m);
  });

  it('rewrites the Host line, the network sentence and the pairing step', () => {
    expect(filtered).toContain('**Host** (let another Runova control this computer)');
    expect(filtered).toContain('between Runova installs on the same network. The second');
    expect(filtered).toContain(
      '2. Give the code to the other device: copy the text with **Copy code** and paste it on the other computer.',
    );
  });

  it('drops the mobile app section with its subsections, up to the next section', () => {
    expect(filtered).not.toContain('## The Runova mobile app');
    expect(filtered).not.toContain('### Pair your phone');
    expect(filtered).not.toContain('### Using the phone as a remote');
    expect(filtered).not.toContain('screen fills the phone');
    expect(filtered).toMatch(
      /> Keyboard control needs a Windows host\. Pick a <name> for it\.\n\n## Tips\n/,
    );
  });

  it('leaves no forbidden phrase', () => {
    expect(forbiddenIn(fixture('remote.md')).length).toBeGreaterThan(0);
    expect(forbiddenIn(filtered)).toEqual([]);
  });

  it('keeps the other sections as they are', () => {
    expect(filtered).toContain('## Host: let another device control this computer');
    expect(filtered).toContain('### Create a pairing code');
    expect(filtered).toContain('[the Vault](vault.md)');
  });
});

describe('the help filter on a fixture with an Android emulator section', () => {
  it('changes nothing in the Android article', () => {
    expect(applyHelpFilter('android.md', fixture('android.md'))).toBe(fixture('android.md'));
  });

  it('keeps the Android emulator example in another article', () => {
    const filtered = applyHelpFilter('first-steps.md', fixture('first-steps.md'));
    expect(filtered).toContain('running the mobile app on the Android emulator');
  });
});

describe('the help filter rules', () => {
  it('are written for files that exist in the app', () => {
    for (const rule of HELP_FILTER) expect(() => article(rule.file)).not.toThrow();
  });

  it('all still change the real articles, so a stale rule is noticed', () => {
    const files = [...new Set(HELP_FILTER.map((rule) => rule.file))];
    for (const file of files) expect(unusedFilterRules(file, article(file))).toEqual([]);
  });

  it('leave the real remote article without a forbidden phrase', () => {
    expect(forbiddenIn(applyHelpFilter('remote.md', article('remote.md')))).toEqual([]);
  });

  it('works on Windows line endings', () => {
    const crlf = fixture('remote.md').replace(/\r?\n/g, '\r\n');
    expect(forbiddenIn(applyHelpFilter('remote.md', crlf))).toEqual([]);
  });
});
