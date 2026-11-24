import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The release workflows hold the signing secrets and a token that can replace release assets.
// The self-hosted runners keep their disks between jobs and run CI for pull requests, so a release
// job on one of them would run next to whatever an earlier job left behind.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseWorkflows = ['cd.yml', 'cd-mobile.yml'];

function read(name) {
  return readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8').replace(/\r\n/g, '\n');
}

// Each job's lines, keyed by its id. Jobs are the two-space keys under the top-level jobs: key.
function jobs(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  assert.notEqual(start, -1, 'no jobs: key');
  const found = new Map();
  let current;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const id = /^ {2}([\w-]+):\s*$/.exec(line);
    if (id) {
      current = [];
      found.set(id[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return found;
}

test('no release job runs on a self-hosted runner', () => {
  const problems = [];
  for (const name of releaseWorkflows) {
    for (const [id, lines] of jobs(read(name))) {
      const runsOn = lines.find((line) => /^ {4}runs-on:/.test(line));
      assert.ok(runsOn, `${name} ${id} has no runs-on`);
      if (/self-hosted/i.test(runsOn)) problems.push(`${name} ${id}: ${runsOn.trim()}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the iOS release job reads its secrets only in the steps that use them, with a read-only token', () => {
  const ios = jobs(read('cd-mobile.yml')).get('ios');
  assert.ok(ios, 'cd-mobile.yml has no ios job');
  const jobLevelSecrets = ios.filter(
    (line) => /\$\{\{\s*secrets\./.test(line) && !/^ {10}\S/.test(line),
  );
  assert.deepEqual(jobLevelSecrets, []);
  const permissions = ios.findIndex((line) => /^ {4}permissions:/.test(line));
  assert.notEqual(permissions, -1, 'the ios job does not set its own permissions');
  assert.match(ios[permissions + 1], /^ {6}contents: read\s*$/);
});
