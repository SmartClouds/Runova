import { describe, expect, it } from 'vitest';
import { interpolateComposeTree, interpolateComposeValue } from './interpolate.js';

/** The mapping compose-go's template_test.go uses. */
const DEFAULTS: Record<string, string> = { FOO: 'first', BAR: '', JSON: '{"json":2}' };
const lookup = (name: string) => DEFAULTS[name];

function value(template: string): string {
  const result = interpolateComposeValue(template, lookup);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function refusal(template: string): string {
  const result = interpolateComposeValue(template, lookup);
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  return result.reason;
}

describe('interpolateComposeValue, as compose-go template_test.go expects', () => {
  it('leaves text without variables alone and reads $$ as a literal $', () => {
    expect(value('foo')).toBe('foo');
    expect(value('$${foo}')).toBe('${foo}');
    expect(value('cost $5 or $')).toBe('cost $5 or $');
  });

  it('substitutes set and unset variables, braced or not', () => {
    expect(value('This $FOO var')).toBe('This first var');
    expect(value('This ${FOO} var')).toBe('This first var');
    expect(value('This ${missing} var')).toBe('This  var');
    expect(value('This ${BAR} var')).toBe('This  var');
    expect(value('ok ${JSON}')).toBe('ok {"json":2}');
    expect(value('${FOO}${FOO}-$FOO.$FOO')).toBe('firstfirst-first.first');
  });

  it('applies the default forms', () => {
    expect(value('ok ${missing:-def}')).toBe('ok def');
    expect(value('ok ${missing-def}')).toBe('ok def');
    expect(value('ok ${BAR:-def}')).toBe('ok def');
    expect(value('ok ${FOO:-def}')).toBe('ok first');
    expect(value('ok ${BAR-def}')).toBe('ok ');
    expect(value('ok ${BAR:-/non:-alphanumeric}')).toBe('ok /non:-alphanumeric');
    expect(value('${missing:-a} and ${FOO}')).toBe('a and first');
  });

  it('expands variables inside defaults', () => {
    expect(value('ok ${UNSET_VAR-$FOO}')).toBe('ok first');
    expect(value('ok ${BAR-$FOO}')).toBe('ok ');
    expect(value('ok ${UNSET_VAR:-${UNSET_VAR:-${FOO}}}')).toBe('ok first');
    expect(value('ok ${UNSET_VAR:-$FOO}')).toBe('ok first');
  });

  it('applies the presence forms', () => {
    expect(value('ok ${UNSET_VAR:+presence_value}')).toBe('ok ');
    expect(value('ok ${UNSET_VAR+presence_value}')).toBe('ok ');
    expect(value('ok ${FOO:+presence_value}')).toBe('ok presence_value');
    expect(value('ok ${FOO+presence_value}')).toBe('ok presence_value');
    expect(value('ok ${BAR+presence_value}')).toBe('ok presence_value');
    expect(value('ok ${BAR:+presence_value}')).toBe('ok ');
  });

  it('refuses a required variable that is missing, with its message', () => {
    expect(refusal('not ok ${UNSET_VAR:?Mandatory Variable Unset}')).toBe(
      'UNSET_VAR is required: Mandatory Variable Unset',
    );
    expect(refusal('not ok ${BAR:?Mandatory Variable Empty}')).toBe(
      'BAR is required: Mandatory Variable Empty',
    );
    expect(refusal('not ok ${UNSET_VAR:?}')).toBe('UNSET_VAR is required.');
    expect(refusal('not ok ${UNSET_VAR?Mandatory Variable Unset}')).toMatch(
      /UNSET_VAR is required/,
    );
    expect(value('ok ${FOO:?err}')).toBe('ok first');
    expect(value('ok ${BAR?err}')).toBe('ok ');
  });

  it('refuses broken templates', () => {
    for (const template of ['${', '${}', '${ }', '${ foo}', '${foo }', '${foo!}', 'a ${b']) {
      expect(refusal(template)).toMatch(/isn't a valid \$\{\.\.\.\}/);
    }
    expect(refusal('${A:-one\ntwo}')).toMatch(/isn't a valid/);
  });

  it('reports variables that were used but not set', () => {
    const result = interpolateComposeValue('${A} $B ${C:-x} ${FOO}', lookup);
    expect(result.ok && result.missing).toEqual(['A', 'B']);
  });

  it('refuses defaults nested past any sensible depth', () => {
    const deep = `${'${X:-'.repeat(200)}end${'}'.repeat(200)}`;
    expect(refusal(deep)).toMatch(/nested/);
  });
});

describe('interpolateComposeTree', () => {
  it('interpolates every string value, never keys, and leaves other scalars alone', () => {
    const result = interpolateComposeTree(
      {
        services: {
          web: { image: 'nginx:${TAG:-1.27}', ports: ['${PORT}:80', 443], privileged: false },
        },
        'x-${FOO}': '${FOO}',
      },
      (name) => ({ PORT: '8080' })[name],
    );
    expect(result).toEqual({
      ok: true,
      value: {
        services: { web: { image: 'nginx:1.27', ports: ['8080:80', 443], privileged: false } },
        'x-${FOO}': '',
      },
      missing: ['FOO'],
    });
  });

  it('says where a broken value is', () => {
    const result = interpolateComposeTree(
      { services: { web: { environment: { A: '${NEEDED:?set it}' } } } },
      () => undefined,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'services.web.environment.A: NEEDED is required: set it',
      unsetVariable: 'NEEDED',
    });
  });

  it('names no unset variable when the value itself is broken', () => {
    const result = interpolateComposeTree(
      { services: { web: { image: 'nginx:${TAG' } } },
      () => undefined,
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('unsetVariable');
  });
});
