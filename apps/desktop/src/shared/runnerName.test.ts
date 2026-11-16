import { describe, expect, it } from 'vitest';
import { runnerNameFrom, validateRunnerName } from './runnerName';

describe('validateRunnerName', () => {
  it('accepts letters, digits, dots, dashes and underscores', () => {
    expect(validateRunnerName('build-box_01.lan', [])).toBeNull();
  });

  it('asks for a name when it is empty or only spaces', () => {
    expect(validateRunnerName('', [])).toBe('Give the runner a name.');
    expect(validateRunnerName('   ', [])).toBe('Give the runner a name.');
  });

  it('refuses spaces and other characters config.sh would reject', () => {
    expect(validateRunnerName('my runner', [])).toMatch(/letters, digits/);
    expect(validateRunnerName('box/1', [])).toMatch(/letters, digits/);
  });

  it('refuses names longer than 64 characters', () => {
    expect(validateRunnerName('a'.repeat(64), [])).toBeNull();
    expect(validateRunnerName('a'.repeat(65), [])).toMatch(/64/);
  });

  it('refuses a name already taken in the repo, ignoring case', () => {
    expect(validateRunnerName('Build-Box', ['build-box'])).toBe(
      'A runner called Build-Box is already registered here.',
    );
  });
});

describe('runnerNameFrom', () => {
  it('keeps the short host name, lower case', () => {
    expect(runnerNameFrom('DESKTOP-42.corp.example.com')).toBe('desktop-42');
  });

  it('turns a nickname into a slug', () => {
    expect(runnerNameFrom('My Hetzner Box!')).toBe('my-hetzner-box');
  });

  it('keeps an IP address whole instead of cutting it at the first dot', () => {
    expect(runnerNameFrom('203.0.113.7')).toBe('203-0-113-7');
  });

  it('trims to 64 characters and never ends on a dash', () => {
    const name = runnerNameFrom(`${'x'.repeat(63)} y`);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith('-')).toBe(false);
  });

  it('falls back to a plain name when nothing usable is left', () => {
    expect(runnerNameFrom('!!!')).toBe('runner');
  });
});
