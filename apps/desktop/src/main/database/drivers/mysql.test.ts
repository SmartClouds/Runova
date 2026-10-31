import { describe, expect, it } from 'vitest';
import { accessFromGrants } from './mysql';

/** MySQL's SHOW GRANTS lines, read as the access levels the Users tab shows. */

describe('accessFromGrants', () => {
  it('reads each database at its highest level', () => {
    expect(
      accessFromGrants([
        'GRANT USAGE ON *.* TO `app`@`%`',
        'GRANT SELECT ON `shop`.* TO `app`@`%`',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON `shop`.* TO `app`@`%`',
        'GRANT SELECT ON `blog`.* TO `app`@`%`',
      ]),
    ).toEqual([
      { database: 'shop', level: 'write' },
      { database: 'blog', level: 'read' },
    ]);
  });

  it('reads ALL PRIVILEGES on *.* as admin of every database', () => {
    expect(
      accessFromGrants(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION']),
    ).toEqual([{ database: '*', level: 'admin' }]);
  });

  it('skips grants on single tables and ones it does not understand', () => {
    expect(
      accessFromGrants([
        'GRANT SELECT ON `shop`.`orders` TO `x`@`%`',
        'GRANT PROXY ON ``@`` TO `x`@`%`',
      ]),
    ).toEqual([]);
  });
});
