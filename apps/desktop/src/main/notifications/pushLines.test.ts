import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composePushLine } from './pushLines';

interface LineCase {
  category: string;
  status: string | null;
  agent: string | null;
  project: string | null;
  subject: string | null;
  line: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '../../../../../packages/protocol/test-vectors/push-lines-v1.json');
const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: LineCase[] };

describe('push lines', () => {
  it.each(cases)('says what the server would for $category $status', (item) => {
    expect(composePushLine(item)).toBe(item.line);
  });

  it('knows nothing about a category it has no template for', () => {
    expect(composePushLine({ category: 'account' })).toBeNull();
  });

  it('refuses a status that does not belong to the category', () => {
    expect(composePushLine({ category: 'tasks', status: 'exploded', project: 'Shop' })).toBeNull();
  });

  it('refuses when a name the template needs is missing', () => {
    expect(composePushLine({ category: 'tasks', status: 'added' })).toBeNull();
  });

  it('takes a name literally, even one that looks like a pattern', () => {
    expect(composePushLine({ category: 'monitors', status: 'failed', subject: '$& api' })).toBe(
      '$& api is down',
    );
  });
});
