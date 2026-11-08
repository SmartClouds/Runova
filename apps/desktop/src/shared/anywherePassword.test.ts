import { describe, expect, it } from 'vitest';
import { passwordProblem, passwordStrength } from './anywherePassword';

describe('unattended-access password rules', () => {
  it('asks for at least 10 characters', () => {
    expect(passwordProblem('short1!')).toMatch(/10 characters/);
    expect(passwordProblem('long enough phrase')).toBeNull();
  });

  it('refuses passwords everyone tries first', () => {
    expect(passwordProblem('password123')).toMatch(/common/);
    expect(passwordProblem('1234567890')).toMatch(/common/);
    expect(passwordProblem('qwertyuiop')).toMatch(/common/);
  });

  it('refuses one character repeated', () => {
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/repeat/);
  });

  it('rates longer and more varied passwords higher', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('abcdefghij')).toBeLessThan(passwordStrength('Correct-Horse-7'));
    expect(passwordStrength('correct horse battery staple 42')).toBe(4);
  });
});
