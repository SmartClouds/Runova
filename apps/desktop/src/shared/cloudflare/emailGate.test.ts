import { describe, expect, it } from 'vitest';
import type { EmailGateInput } from '../cloudflareTypes';
import {
  EMAIL_GATE_SESSIONS,
  emailGateApp,
  emailGateBypassDomain,
  emailGatePreview,
  emailGateSummary,
  hostnameInZone,
  isEmailGateSession,
  MAX_EMAIL_GATE_PEOPLE,
  parsePeople,
  parsePeopleEntry,
  peopleCount,
  validateEmailGateInput,
  validateTeamName,
} from './emailGate';

/**
 * The email code gate (E96): Cloudflare Access in front of a hostname, letting in the people listed
 * once they type the code Cloudflare mails them. The dialog checks what it sends with this as the
 * user types, and the main process checks it again before it goes to Cloudflare.
 */

const INPUT: EmailGateInput = {
  zoneId: 'zone-1',
  hostname: 'app.example.com',
  emails: ['ana@example.com'],
  emailDomains: [],
  session: '24h',
};

describe('parsePeopleEntry', () => {
  it('takes an email address, lower cased and trimmed', () => {
    expect(parsePeopleEntry('  Ana@Example.COM ')).toEqual({
      kind: 'email',
      value: 'ana@example.com',
    });
  });

  it('takes a whole email domain written with or without the @', () => {
    expect(parsePeopleEntry('@Company.com')).toEqual({ kind: 'domain', value: 'company.com' });
    expect(parsePeopleEntry('company.co.uk')).toEqual({ kind: 'domain', value: 'company.co.uk' });
  });

  it('takes the address out of a "Name <address>" entry pasted from a mail app', () => {
    expect(parsePeopleEntry('Ana Silva <ana@example.com>')).toEqual({
      kind: 'email',
      value: 'ana@example.com',
    });
  });

  it('says what is wrong with an entry it cannot use', () => {
    expect(parsePeopleEntry('ana@')).toMatchObject({ kind: 'invalid', value: 'ana@' });
    expect(parsePeopleEntry('not an email')).toMatchObject({ kind: 'invalid' });
    expect(parsePeopleEntry('@localhost')).toMatchObject({ kind: 'invalid' });
    const bad = parsePeopleEntry('a@b@c.com');
    expect(bad.kind === 'invalid' && bad.reason).toMatch(/email/i);
  });
});

describe('parsePeople', () => {
  it('splits pasted text on commas, semicolons, spaces and new lines', () => {
    expect(parsePeople('ana@example.com, bo@example.com;\n@company.com  cy@example.com')).toEqual([
      { kind: 'email', value: 'ana@example.com' },
      { kind: 'email', value: 'bo@example.com' },
      { kind: 'domain', value: 'company.com' },
      { kind: 'email', value: 'cy@example.com' },
    ]);
  });

  it('keeps a "Name <address>" entry together and drops repeats', () => {
    expect(parsePeople('Ana Silva <ana@example.com>, ana@example.com')).toEqual([
      { kind: 'email', value: 'ana@example.com' },
    ]);
  });

  it('gives nothing for blank text', () => {
    expect(parsePeople(' ,; \n')).toEqual([]);
  });
});

describe('isEmailGateSession', () => {
  it('knows the five lengths the dialog offers, 24 hours among them', () => {
    expect(EMAIL_GATE_SESSIONS.map((session) => session.value)).toEqual([
      '30m',
      '6h',
      '24h',
      '168h',
      '720h',
    ]);
    expect(isEmailGateSession('24h')).toBe(true);
    expect(isEmailGateSession('1h')).toBe(false);
    expect(isEmailGateSession(24)).toBe(false);
  });
});

describe('hostnameInZone', () => {
  it('matches the zone itself and its subdomains only', () => {
    expect(hostnameInZone('example.com', 'example.com')).toBe(true);
    expect(hostnameInZone('App.Example.com', 'example.com')).toBe(true);
    expect(hostnameInZone('notexample.com', 'example.com')).toBe(false);
    expect(hostnameInZone('example.com.au', 'example.com')).toBe(false);
  });
});

describe('validateEmailGateInput', () => {
  it('lets a complete gate through', () => {
    expect(validateEmailGateInput(INPUT, 'example.com')).toBeNull();
    expect(
      validateEmailGateInput(
        { ...INPUT, emails: [], emailDomains: ['example.com'] },
        'example.com',
      ),
    ).toBeNull();
  });

  it('wants at least one person or domain', () => {
    expect(validateEmailGateInput({ ...INPUT, emails: [] }, 'example.com')).toMatch(
      /at least one/i,
    );
  });

  it('refuses an address or domain it cannot read', () => {
    expect(validateEmailGateInput({ ...INPUT, emails: ['nope'] }, 'example.com')).toMatch(/nope/);
    expect(
      validateEmailGateInput({ ...INPUT, emailDomains: ['bad domain'] }, 'example.com'),
    ).toMatch(/bad domain/);
  });

  it('keeps the list to the limit', () => {
    const many = Array.from({ length: MAX_EMAIL_GATE_PEOPLE + 1 }, (_, i) => `p${i}@example.com`);
    expect(validateEmailGateInput({ ...INPUT, emails: many }, 'example.com')).toMatch(
      String(MAX_EMAIL_GATE_PEOPLE),
    );
  });

  it('wants a session length from the list', () => {
    expect(
      validateEmailGateInput(
        { ...INPUT, session: '1h' as EmailGateInput['session'] },
        'example.com',
      ),
    ).toMatch(/how long/i);
  });

  it('wants the hostname to be in the zone, and no wildcard or path', () => {
    expect(validateEmailGateInput({ ...INPUT, hostname: 'app.other.io' }, 'example.com')).toMatch(
      /example\.com/,
    );
    expect(validateEmailGateInput({ ...INPUT, hostname: '*.example.com' }, 'example.com')).toMatch(
      /hostname/i,
    );
    expect(
      validateEmailGateInput({ ...INPUT, hostname: 'example.com/admin' }, 'example.com'),
    ).toMatch(/hostname/i);
  });
});

describe('validateTeamName', () => {
  it('takes lower case letters, digits and inner dashes', () => {
    expect(validateTeamName('acme-team')).toBeNull();
    expect(validateTeamName('Acme')).toMatch(/lower case/i);
    expect(validateTeamName('-acme')).not.toBeNull();
    expect(validateTeamName('')).toMatch(/team name/i);
  });
});

describe('peopleCount, emailGateSummary and emailGatePreview', () => {
  it('counts people and domains together', () => {
    expect(peopleCount({ emails: ['a@x.io', 'b@x.io'], emailDomains: ['y.io'] })).toBe(3);
  });

  it('sums up a gate for its row', () => {
    expect(emailGateSummary({ emails: ['a@x.io'], emailDomains: [], session: '24h' })).toBe(
      'Email code, 1 person, 24 hours',
    );
    expect(
      emailGateSummary({ emails: ['a@x.io', 'b@x.io'], emailDomains: ['y.io'], session: '30m' }),
    ).toBe('Email code, 3 people, 30 minutes');
  });

  it('says in a sentence who gets in and for how long', () => {
    expect(
      emailGatePreview(
        { emails: ['ana@example.com'], emailDomains: ['company.com'], session: '168h' },
        'app.example.com',
      ),
    ).toBe(
      'Anyone at @company.com and ana@example.com can open app.example.com for 7 days after typing a code.',
    );
    expect(
      emailGatePreview(
        { emails: ['a@x.io', 'b@x.io', 'c@x.io'], emailDomains: [], session: '24h' },
        'x.io',
      ),
    ).toBe('a@x.io and 2 more people can open x.io for 24 hours after typing a code.');
    expect(emailGatePreview({ emails: [], emailDomains: [], session: '24h' }, 'x.io')).toBe(
      'Add at least one email or domain to say who can open x.io.',
    );
  });
});

describe('emailGateApp and emailGateBypassDomain', () => {
  it('names the apps Runova makes so they are found again, and no other', () => {
    expect(emailGateApp.name('app.example.com')).toBe('Runova, app.example.com');
    expect(emailGateApp.bypassName('app.example.com')).toBe(
      'Runova, app.example.com, certificate checks',
    );
    expect(emailGateApp.isOurs({ name: 'Runova, app.example.com' })).toBe(true);
    expect(emailGateApp.isOurs({ name: 'Runova SSH, web-1' })).toBe(false);
    expect(emailGateApp.isOurs({ name: 'Team wiki' })).toBe(false);
  });

  it('leaves the certificate challenge path open for renewals', () => {
    expect(emailGateBypassDomain('app.example.com')).toBe(
      'app.example.com/.well-known/acme-challenge',
    );
  });
});
