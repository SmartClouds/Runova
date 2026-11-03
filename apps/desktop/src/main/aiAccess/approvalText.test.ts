import { describe, expect, it } from 'vitest';
import { approvalText } from './approvalText';

/**
 * The approval as plain text, for a CLI that asks the user itself. It carries the same facts as
 * the Runova window, with secret values masked since the terminal may be shared or recorded.
 */

describe('approvalText', () => {
  it('says who wants what, where, and how risky it is', () => {
    const text = approvalText({
      agent: 'Claude Code',
      toolTitle: 'Save an env file',
      risk: 'sensitive',
      projectName: 'Shop',
      preview: {
        title: 'Update .env.local in Staging',
        summary: 'Replaces the whole file.',
        fields: [
          { label: 'Environment', value: 'Staging' },
          { label: 'Token', value: 'abc123', secret: true },
        ],
      },
    });

    expect(text).toBe(
      [
        'Claude Code wants to: Update .env.local in Staging',
        'Project: Shop · Sensitive',
        'Replaces the whole file.',
        '',
        'Environment: Staging',
        'Token: ••••••',
      ].join('\n'),
    );
  });

  it('lists the lines an edit adds and removes, with values masked for a secret file', () => {
    const text = approvalText({
      agent: 'Codex',
      toolTitle: 'Save an env file',
      risk: 'sensitive',
      projectName: null,
      preview: {
        title: 'Update .env',
        diff: {
          fileName: '.env',
          before: 'A=1\nB=2\n# note',
          after: 'A=1\nB=3\nC=secret\n# note',
          secret: true,
        },
      },
    });

    expect(text).toContain('Changes to .env (2 added, 1 removed):');
    expect(text).toContain('- B=••••••');
    expect(text).toContain('+ B=••••••');
    expect(text).toContain('+ C=••••••');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('A=1');
  });

  it('shows an HTTP request on one line plus its body', () => {
    const text = approvalText({
      agent: 'Claude Code',
      toolTitle: 'Send a request',
      risk: 'sensitive',
      projectName: 'Shop',
      preview: {
        title: 'Send Login',
        request: { method: 'POST', url: 'https://api.test/login', body: '{"user":"a"}' },
      },
    });

    expect(text).toContain('POST https://api.test/login');
    expect(text).toContain('{"user":"a"}');
  });
});
