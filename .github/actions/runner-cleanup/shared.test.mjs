// Run with: node --test .github/actions/runner-cleanup/shared.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { busiestProcessesIn, etimeSeconds, strayProcessesIn } from './shared.mjs';

const work = '/Volumes/SmartAgent-Mac-01/actions-runner/_work';

test('reads every shape of ps etime', () => {
  assert.equal(etimeSeconds('00:07'), 7);
  assert.equal(etimeSeconds('12:34'), 754);
  assert.equal(etimeSeconds('03:00:00'), 10_800);
  assert.equal(etimeSeconds('01-12:37:01'), 131_821);
  assert.equal(etimeSeconds('nonsense'), null);
});

test('picks only an old orphan of this user from this runner', () => {
  const ps = [
    // The pnpm that ran for a day and a half: picked.
    `69554     1   501 01-12:37:01 ${work}/_tool/setup-pnpm/node_modules/pnpm/pnpm self-update 12.18.0`,
    // A job's own process, still under its Runner.Worker.
    `70001 69990   501 01-12:37:01 ${work}/_tool/node/26/bin/node test.js`,
    // A fresh orphan, which a job running right now may still be waiting on.
    `70002     1   501    02:10:00 ${work}/_tool/dotnet/dotnet build-server`,
    // Another user's.
    `70003     1     0 03-00:00:00 ${work}/_tool/setup-pnpm/node_modules/pnpm/pnpm`,
    // The other runner on the same machine.
    '70004     1   501 03-00:00:00 /Users/me/actions-runner/curalink-ios/_work/_tool/node/bin/node',
    // Not from a work folder at all.
    '70005     1   501 03-00:00:00 /Applications/Chrome.app/Contents/MacOS/Chrome',
    // A folder whose name only starts like the work folder.
    `70006     1   501 03-00:00:00 ${work}2/_tool/node/bin/node`,
  ].join('\n');

  const strays = strayProcessesIn(ps, { uid: 501, workRoot: work });

  assert.deepEqual(
    strays.map((stray) => stray.pid),
    [69554],
  );
  assert.equal(strays[0].age, 131_821);
});

test('busiestProcessesIn lists the busiest first and skips what it can not read', () => {
  const ps = [
    '  101   0.0       00:05 /bin/sleep 100',
    '  202 786.7 01-14:05:45 /work/_tool/setup-pnpm/node_modules/pnpm/pnpm self-update 12.18.0',
    'garbage',
    '  303  12.5    10:00 cargo clippy',
  ].join('\n');
  const lines = busiestProcessesIn(ps, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\s+787%\s+202\s+01-14:05:45\s+.*self-update/);
  assert.match(lines[1], /^\s+13%\s+303\s+10:00\s+cargo clippy$/);
});
