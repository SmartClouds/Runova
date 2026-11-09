import { describe, expect, it } from 'vitest';
import {
  baseVersion,
  type DependencyFinding,
  findingRowKey,
  type InventoryEcosystem,
  packageRowKey,
  tidyInventory,
} from './dependencyAlerts';

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

describe('matching a finding to its row in the Packages tab', () => {
  function finding(ecosystem: InventoryEcosystem, name: string): DependencyFinding {
    return {
      ecosystem,
      name,
      kind: 'major',
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      advisoryId: null,
      severity: null,
      summary: null,
      firstSeenAt: '2026-11-09T00:00:00Z',
    };
  }

  it('matches a Swift package uploaded by address to the row named after its repository', () => {
    expect(findingRowKey(finding('swift', 'github.com/Alamofire/Alamofire'))).toBe(
      packageRowKey('Alamofire', 'spm'),
    );
  });

  it('matches a pod uploaded by its root to the row of any of its subspecs', () => {
    expect(findingRowKey(finding('pods', 'Firebase'))).toBe(
      packageRowKey('Firebase/Analytics', 'cocoapods'),
    );
  });

  it('keeps full names everywhere else, without case', () => {
    expect(findingRowKey(finding('nuget', 'Serilog'))).toBe(packageRowKey('serilog', 'nuget'));
    expect(findingRowKey(finding('npm', '@scope/pkg'))).toBe(packageRowKey('@scope/pkg', 'npm'));
    expect(findingRowKey(finding('maven', 'a.b:c'))).toBe(packageRowKey('a.b:c', 'gradle'));
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
