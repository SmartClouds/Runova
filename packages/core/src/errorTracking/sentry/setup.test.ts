import { describe, expect, it } from 'vitest';
import * as errorTracking from '../index.js';
import {
  buildSentrySetup,
  canCreateProjects,
  SENTRY_CREATE_SCOPE,
  SENTRY_PLATFORMS,
  sentryKeysPageUrl,
  suggestSentryPlatform,
  validateSentryProjectName,
} from './setup.js';

/**
 * What a new Sentry project needs before and after it exists: the scope that lets a token make
 * one, a name Sentry takes, and the snippet that puts its DSN to work.
 */

// Written as a code so this file holds no em dash itself.
const EM_DASH = String.fromCharCode(0x2014);
const DSN = 'https://abcdef0123456789abcdef0123456789@o1.ingest.sentry.io/104';

describe('the module index', () => {
  it('exports the setup helpers', () => {
    expect(errorTracking.buildSentrySetup).toBe(buildSentrySetup);
    expect(errorTracking.SENTRY_CREATE_SCOPE).toBe('project:write');
  });
});

describe('canCreateProjects', () => {
  it('is true when the token can write or administer projects', () => {
    expect(canCreateProjects(['org:read', SENTRY_CREATE_SCOPE])).toBe(true);
    expect(canCreateProjects(['project:admin'])).toBe(true);
  });

  it('is false when the scopes are known and neither is there', () => {
    expect(canCreateProjects(['org:read', 'project:read', 'event:read'])).toBe(false);
  });

  it('is null when the provider did not report scopes', () => {
    expect(canCreateProjects(null)).toBeNull();
  });
});

describe('validateSentryProjectName', () => {
  it('trims the name and takes it', () => {
    expect(validateSentryProjectName('  Storefront API  ')).toEqual({
      ok: true,
      value: 'Storefront API',
    });
  });

  it('asks for a name when there is none', () => {
    expect(validateSentryProjectName('   ')).toEqual({ ok: false, reason: 'Enter a name.' });
  });

  it('refuses a name longer than Sentry takes', () => {
    expect(validateSentryProjectName('a'.repeat(51))).toEqual({
      ok: false,
      reason: 'Use 50 characters or fewer.',
    });
    expect(validateSentryProjectName('a'.repeat(50)).ok).toBe(true);
  });

  it('refuses a name with no letter or digit, since Sentry makes the slug from them', () => {
    expect(validateSentryProjectName('---')).toEqual({
      ok: false,
      reason: 'Use at least one letter or digit.',
    });
  });
});

describe('SENTRY_PLATFORMS', () => {
  it('has unique ids and ends with Other', () => {
    const ids = SENTRY_PLATFORMS.map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('other');
  });

  it('links every platform to the Sentry docs', () => {
    for (const platform of SENTRY_PLATFORMS) {
      expect(platform.docsUrl).toMatch(/^https:\/\/docs\.sentry\.io\/platforms\//);
    }
  });
});

describe('buildSentrySetup', () => {
  it.each(SENTRY_PLATFORMS.map((one) => one.id))('puts the DSN into the %s snippet', (id) => {
    const setup = buildSentrySetup(id, DSN);
    expect(setup.code).toContain(DSN);
    expect(setup.env).toBe(`SENTRY_DSN=${DSN}`);
    expect(`${setup.install}${setup.code}`).not.toContain(EM_DASH);
  });

  it('gives React its package and init call', () => {
    expect(buildSentrySetup('javascript-react', DSN)).toMatchObject({
      platform: { id: 'javascript-react', label: 'React' },
      install: 'npm install --save @sentry/react',
      language: 'javascript',
    });
    expect(buildSentrySetup('javascript-react', DSN).code).toContain(
      'import * as Sentry from "@sentry/react";',
    );
  });

  it('falls back to Other for a platform it does not know', () => {
    expect(buildSentrySetup('cobol', DSN).platform.id).toBe('other');
  });

  it('escapes a quote in the DSN so the snippet stays valid', () => {
    expect(buildSentrySetup('node', 'https://a"b@x/1').code).toContain('https://a\\"b@x/1');
  });
});

describe('suggestSentryPlatform', () => {
  it('matches a Sentry platform exactly', () => {
    expect(suggestSentryPlatform('javascript-react')).toBe('javascript-react');
    expect(suggestSentryPlatform('python')).toBe('python');
  });

  it('matches a framework guide to its language', () => {
    expect(suggestSentryPlatform('python-django')).toBe('python');
    expect(suggestSentryPlatform('javascript-vue')).toBe('javascript');
    expect(suggestSentryPlatform('node-express')).toBe('node');
    expect(suggestSentryPlatform('dotnet')).toBe('dotnet');
  });

  it('is Other when there is nothing to go on', () => {
    expect(suggestSentryPlatform(null)).toBe('other');
    expect(suggestSentryPlatform('cobol')).toBe('other');
  });
});

describe('sentryKeysPageUrl', () => {
  it('opens the project keys settings on the connected host', () => {
    expect(sentryKeysPageUrl('https://sentry.io/', 'acme', 'storefront web')).toBe(
      'https://sentry.io/settings/acme/projects/storefront%20web/keys/',
    );
  });
});
