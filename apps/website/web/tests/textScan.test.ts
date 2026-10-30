import { describe, expect, it } from 'vitest';
import { forbiddenPhrases, scanHtml } from './helpers/textScan';

const page = (body: string, head = '') =>
  `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

describe('forbiddenPhrases', () => {
  it('reads the phrases from the spec up to the help filter', () => {
    const phrases = forbiddenPhrases();
    expect(phrases).toContain('runova mobile');
    expect(phrases).toContain('react native');
    expect(phrases.some((phrase) => phrase.startsWith('#'))).toBe(false);
    expect(phrases.some((phrase) => phrase.includes('remote.md'))).toBe(false);
  });
});

describe('scanHtml', () => {
  it('passes a clean page', () => {
    expect(scanHtml(page('<h1>Runova</h1><p>Agents, side by side.</p>'))).toEqual([]);
  });

  it('finds a forbidden phrase in visible text, whatever its case', () => {
    const problems = scanHtml(page('<p>Works with the RUNOVA Mobile app.</p>'));
    expect(problems).toEqual([expect.objectContaining({ kind: 'phrase', match: 'runova mobile' })]);
  });

  it('finds a forbidden phrase split by markup or extra spaces', () => {
    expect(scanHtml(page('<p>Get it on <b>Google</b>\n   Play</p>'))).toEqual([
      expect.objectContaining({ kind: 'phrase', match: 'google play' }),
    ]);
  });

  it('finds a forbidden phrase in an attribute', () => {
    expect(scanHtml(page('<img src="a.png" alt="Runova on an iPad">'))).toEqual([
      expect.objectContaining({ kind: 'phrase', match: 'ipad' }),
    ]);
  });

  it('finds a forbidden phrase in JSON-LD', () => {
    const jsonLd = '<script type="application/ld+json">{"operatingSystem":"iOS app"}</script>';
    expect(scanHtml(page('', jsonLd))).toEqual([
      expect.objectContaining({ kind: 'phrase', match: 'ios app' }),
    ]);
  });

  it('finds the em dash as a character and as an entity', () => {
    const kinds = (html: string) => scanHtml(page(html)).map((problem) => problem.kind);
    expect(kinds('<p>Fast — and calm</p>')).toEqual(['em-dash']);
    expect(kinds('<p>Fast &mdash; and calm</p>')).toEqual(['em-dash']);
    expect(kinds('<p>Fast &#8212; and calm</p>')).toEqual(['em-dash']);
    expect(kinds('<p title="a &#x2014; b">x</p>')).toEqual(['em-dash']);
  });

  it('ignores styles and scripts that are not JSON-LD', () => {
    const head = '<style>.a::after{content:"—"}</style><script>const x = "iPhone";</script>';
    expect(scanHtml(page('<p>ok</p>', head))).toEqual([]);
  });

  it('gives the text around a match so a failure is easy to find', () => {
    const [problem] = scanHtml(page('<p>Start the agents. Pair your phone later.</p>'));
    expect(problem.context).toContain('Pair your phone');
  });
});
