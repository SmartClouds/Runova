import { describe, expect, it } from 'vitest';
import { baseVersion, tidyInventory } from './dependencyAlerts';

describe('baseVersion', () => {
  it.each([
    ['4.17.20', '4.17.20'],
    ['^4.17.20', '4.17.20'],
    ['~0.3', '0.3.0'],
    ['>=2.0.0 <3', '2.0.0'],
    ['1.x', '1.0.0'],
    ['^1.2.0 || ^2.0.0', '1.2.0'],
    ['[2.1.35]', '2.1.35'],
    ['[1.0,2.0)', '1.0.0'],
    ['13.0.3.1', '13.0.3.1'],
    ['8.0.0-preview.7', '8.0.0-preview.7'],
    ['v2.1.0', '2.1.0'],
  ])('reads %s as %s', (text, version) => {
    expect(baseVersion(text)).toBe(version);
  });

  it.each([
    '',
    '*',
    'latest',
    'workspace:*',
    'file:../lib',
    'github:user/repo',
    'npm:other@1.0.0',
    'https://example.com/x.tgz',
    null,
    undefined,
  ])('refuses %s', (text) => {
    expect(baseVersion(text)).toBeNull();
  });
});

describe('tidyInventory', () => {
  it('keeps the first of each package, NuGet names regardless of case, sorted by name', () => {
    expect(
      tidyInventory([
        { ecosystem: 'nuget', name: 'Serilog', version: '3.1.1', dev: false },
        { ecosystem: 'npm', name: 'axios', version: '1.7.0', dev: false },
        { ecosystem: 'nuget', name: 'serilog', version: '4.0.0', dev: false },
      ]),
    ).toEqual([
      { ecosystem: 'npm', name: 'axios', version: '1.7.0', dev: false },
      { ecosystem: 'nuget', name: 'Serilog', version: '3.1.1', dev: false },
    ]);
  });
});
