import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_CATEGORIES as APP_CATEGORIES } from '../../../desktop/src/shared/help/parse';
import {
  finishHelpHtml,
  HELP_CATEGORIES,
  type HelpArticleEntry,
  helpByCategory,
  helpLoader,
  helpNeighbours,
  prepareHelpArticle,
  readHelpArticles,
  sortHelpArticles,
} from '../src/lib/help/articles';

const fixtures = fileURLToPath(new URL('./fixtures/help/', import.meta.url));
const appArticles = fileURLToPath(
  new URL('../../../desktop/src/shared/help/articles/', import.meta.url),
);

function byId(entries: HelpArticleEntry[], id: string): HelpArticleEntry {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no entry ${id}`);
  return entry;
}

describe('readHelpArticles on the fixtures', () => {
  const entries = readHelpArticles(fixtures);

  it('makes one entry per file, named after the file', () => {
    expect(entries.map((entry) => entry.id).sort()).toEqual(['android', 'first-steps', 'remote']);
  });

  it('reads the front matter like the app does', () => {
    const android = byId(entries, 'android').data;
    expect(android).toMatchObject({
      title: 'Android',
      category: 'Ship',
      order: 50,
      route: '/android',
      keywords: ['android', 'emulator', 'avd', 'adb', 'phone', 'usb debugging'],
    });
    expect(byId(entries, 'first-steps').data.category).toBe('Getting started');
    expect(byId(entries, 'first-steps').data.route).toBeUndefined();
  });

  it('applies the mobile filter before parsing', () => {
    const remote = byId(entries, 'remote');
    expect(remote.data.keywords).not.toContain('mobile');
    expect(remote.data.summary).not.toMatch(/mobile/i);
    expect(remote.body).not.toMatch(/mobile app|iPhone|phone/);
    expect(remote.data.toc.map((item) => item.heading)).toEqual([
      'Host: let another device control this computer',
      'Create a pairing code',
      'Tips',
    ]);
  });

  it('keeps the Android emulator and phone content', () => {
    const android = byId(entries, 'android');
    expect(android.body).toContain('## Connect a phone');
    expect(android.body).toContain('Pair device with pairing code');
    expect(android.data.toc).toEqual([
      { id: 'start-an-emulator', heading: 'Start an emulator', level: 2 },
      { id: 'connect-a-phone', heading: 'Connect a phone', level: 2 },
      { id: 'over-wi-fi', heading: 'Over Wi-Fi', level: 3 },
    ]);
  });

  it('turns links to other articles into help pages and leaves the rest', () => {
    const remote = byId(entries, 'remote').body;
    expect(remote).toContain('[SSH](/help/ssh-files#keys)');
    expect(remote).toContain('[the Vault](/help/vault)');
    expect(remote).toContain('[the top](#host-let-another-device-control-this-computer)');
    expect(remote).toContain('[the docs](https://example.com/remote.md)');
    expect(byId(entries, 'first-steps').body).toContain(
      '[Remote](/help/remote#create-a-pairing-code)',
    );
  });

  it('escapes placeholders in angle brackets, but not inside code', () => {
    expect(byId(entries, 'remote').body).toContain('Pick a &lt;name> for it.');
    const android = byId(entries, 'android').body;
    expect(android).toContain('adb pair <address>:<port>');
    expect(android).toContain('`<serial>`');
  });
});

describe('readHelpArticles on the app articles', () => {
  const files = readdirSync(appArticles).filter((name) => name.endsWith('.md'));
  const entries = readHelpArticles(appArticles);

  it('makes one entry for every article in the folder', () => {
    expect(entries).toHaveLength(files.length);
    expect(entries.map((entry) => `${entry.id}.md`).sort()).toEqual([...files].sort());
  });

  it('uses the categories of the app', () => {
    expect(HELP_CATEGORIES).toEqual(APP_CATEGORIES);
    for (const entry of entries) expect(HELP_CATEGORIES).toContain(entry.data.category);
  });
});

describe('prepareHelpArticle', () => {
  it('fails on an article without a title, like the app', () => {
    expect(() => prepareHelpArticle('broken.md', '---\norder: 1\n---\nText')).toThrow(/title/);
  });
});

describe('finishHelpHtml', () => {
  const toc = [
    { id: 'host-let-another-device', heading: 'Host: let another device', level: 2 as const },
    { id: 'tips', heading: 'Tips', level: 2 as const },
    { id: 'tips-1', heading: 'Tips', level: 3 as const },
  ];

  it('gives the headings the anchors the app uses, in order', () => {
    const html = finishHelpHtml(
      '<h2 id="hostlet-another-device">Host: let another device</h2><p>x</p><h2>Tips</h2><h3 id="tips">Tips</h3><h4 id="keep">Keep</h4>',
      toc,
    );
    expect(html).toBe(
      '<h2 id="host-let-another-device">Host: let another device</h2><p>x</p><h2 id="tips">Tips</h2><h3 id="tips-1">Tips</h3><h4 id="keep">Keep</h4>',
    );
  });

  it('turns NOTE, TIP and WARNING quotes into labelled callouts', () => {
    const html = finishHelpHtml(
      '<blockquote>\n<p>[!NOTE]\nKeep it short.</p>\n</blockquote><blockquote><p>[!warning] Careful.</p></blockquote><blockquote><p>Plain quote.</p></blockquote>',
      [],
    );
    expect(html).toBe(
      '<blockquote class="callout" data-callout="note">\n<p><strong>Note:</strong> Keep it short.</p>\n</blockquote><blockquote class="callout" data-callout="warning"><p><strong>Warning:</strong> Careful.</p></blockquote><blockquote><p>Plain quote.</p></blockquote>',
    );
  });
});

describe('the order of the help center', () => {
  const sorted = sortHelpArticles(readHelpArticles(fixtures));

  it('sorts by category as the app shows them, then by order and title', () => {
    expect(sorted.map((entry) => entry.id)).toEqual(['first-steps', 'android', 'remote']);
  });

  it('groups articles under their categories and skips empty ones', () => {
    expect(
      helpByCategory(sorted).map((group) => [group.category, group.articles.map((a) => a.id)]),
    ).toEqual([
      ['Getting started', ['first-steps']],
      ['Ship', ['android']],
      ['Connect', ['remote']],
    ]);
  });

  it('links each article to the one before and after it', () => {
    expect(helpNeighbours(sorted, 'first-steps')).toEqual({ next: sorted[1] });
    expect(helpNeighbours(sorted, 'android')).toEqual({ previous: sorted[0], next: sorted[2] });
    expect(helpNeighbours(sorted, 'remote')).toEqual({ previous: sorted[1] });
  });
});

describe('helpLoader', () => {
  it('stores every article with its data and rendered HTML', async () => {
    const stored = new Map<
      string,
      { data: Record<string, unknown>; rendered?: { html: string } }
    >();
    const loader = helpLoader({ base: fixtures });
    await loader.load({
      store: {
        clear: () => stored.clear(),
        set: (entry: {
          id: string;
          data: Record<string, unknown>;
          rendered?: { html: string };
        }) => {
          stored.set(entry.id, entry);
          return true;
        },
      },
      parseData: async ({ data }: { data: Record<string, unknown> }) => data,
      generateDigest: (value: unknown) => JSON.stringify(value).length.toString(),
      // A stand-in renderer: headings get ids the way a slugger would, the rest is a paragraph.
      renderMarkdown: async (markdown: string) => ({
        html: markdown
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const heading = /^(#{2,3})\s+(.*)$/.exec(line);
            if (!heading) return `<p>${line}</p>`;
            const level = heading[1].length;
            return `<h${level} id="x">${heading[2]}</h${level}>`;
          })
          .join(''),
        metadata: {},
      }),
      config: { root: new URL('../', import.meta.url) },
      logger: { info() {}, warn() {} },
      // biome-ignore lint/suspicious/noExplicitAny: the loader reads only the fields above.
    } as any);

    expect([...stored.keys()].sort()).toEqual(['android', 'first-steps', 'remote']);
    const remote = stored.get('remote');
    expect(remote?.data.title).toBe('Remote');
    expect(remote?.rendered?.html).toContain(
      '<h2 id="host-let-another-device-control-this-computer">',
    );
    expect(remote?.rendered?.html).not.toMatch(/mobile app/i);
  });
});
