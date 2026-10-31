// The images the stack runs: neither the API nor the site runs as root, and the API image carries
// the ASP.NET Core runtime only, no SDK.
import { expect, test } from '@playwright/test';
import { compose, exec } from './compose.ts';

/** The UIDs of the processes running in a service's container, from `docker compose top`. */
function processUids(service: string): string[] {
  const top = compose(['top', service]);
  expect(top.status, top.stderr).toBe(0);
  // Newer Compose versions put SERVICE and # columns before UID, so find the column by its name.
  const lines = top.stdout.trim().split('\n');
  const header = lines.findIndex((line) => /(?:^|\s)UID\s/.test(line));
  expect(header, top.stdout).toBeGreaterThanOrEqual(0);
  const column = lines[header].trim().split(/\s+/).indexOf('UID');
  return lines.slice(header + 1).map((line) => line.trim().split(/\s+/)[column]);
}

for (const service of ['api', 'web']) {
  test(`the ${service} container runs as a user other than root`, () => {
    const uids = processUids(service);
    expect(uids.length).toBeGreaterThan(0);
    for (const uid of uids) expect(uid).not.toMatch(/^(?:0|root)$/);
  });
}

test('the API image has the runtime but no SDK', () => {
  const runtimes = exec('api', ['dotnet', '--list-runtimes']);
  expect(runtimes.status, runtimes.stderr).toBe(0);
  expect(runtimes.stdout).toContain('Microsoft.AspNetCore.App 10.');

  const sdks = exec('api', ['dotnet', '--list-sdks']);
  expect(sdks.stdout.trim()).toBe('');
});
