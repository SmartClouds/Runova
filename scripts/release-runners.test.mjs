import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The release workflows hold the signing secrets and a token that can replace release assets.
// The self-hosted runners keep their disks between jobs and run CI for pushes and approved pull
// requests as the same user, so a release job there would run next to whatever an earlier job left
// behind. Only the iOS job runs on one (the owner's choice, to keep it off GitHub-hosted minutes),
// and it takes nothing from the runner: no actions, no cached tools, nothing from PATH.

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

function iosJob() {
  const ios = jobs(read('cd-mobile.yml')).get('ios');
  assert.ok(ios, 'cd-mobile.yml has no ios job');
  return ios;
}

test('no release job but the hardened iOS one runs on a self-hosted runner', () => {
  const problems = [];
  for (const name of releaseWorkflows) {
    for (const [id, lines] of jobs(read(name))) {
      const runsOn = lines.find((line) => /^ {4}runs-on:/.test(line));
      assert.ok(runsOn, `${name} ${id} has no runs-on`);
      const allowed = name === 'cd-mobile.yml' && id === 'ios';
      if (/self-hosted/i.test(runsOn) && !allowed) problems.push(`${name} ${id}: ${runsOn.trim()}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the iOS release job reads its secrets only in the steps that use them, with a read-only token', () => {
  const ios = iosJob();
  const jobLevelSecrets = ios.filter(
    (line) => /\$\{\{\s*secrets\./.test(line) && !/^ {10}\S/.test(line),
  );
  assert.deepEqual(jobLevelSecrets, []);
  const permissions = ios.findIndex((line) => /^ {4}permissions:/.test(line));
  assert.notEqual(permissions, -1, 'the ios job does not set its own permissions');
  assert.match(ios[permissions + 1], /^ {6}contents: read\s*$/);
});

test('the iOS release job takes no tool, shell or build output from the runner it shares', () => {
  const ios = iosJob();
  const text = ios.join('\n');
  // Actions run from the runner's own folders and tool cache, which CI jobs can write to.
  assert.deepEqual(
    ios.filter((line) => /^\s*(-\s+)?uses:/.test(line)),
    [],
  );
  assert.doesNotMatch(text, /\bbrew\b/);
  assert.match(text, /^ {8}shell: \/bin\/bash --noprofile --norc /m);
  assert.match(text, /^ {6}GIT_CONFIG_GLOBAL: \/dev\/null$/m);
  // Every run step starts from the system PATH or the job's own tools, never the runner's PATH.
  const runs = text.split(/^ {8}run: \|$/m).slice(1);
  assert.ok(runs.length >= 4, `only ${runs.length} run steps found`);
  for (const body of runs) {
    assert.match(body.trimStart(), /^export PATH="\$(SYSTEM_PATH|RELEASE_PATH)"/);
  }
  // Every download is checked against a pinned SHA-256 before it is used.
  assert.equal((text.match(/^ {10}fetch "https:/gm) ?? []).length, 3);
  for (const name of ['NODE', 'XCODEGEN', 'RUSTUP']) {
    assert.match(text, new RegExp(`^ {6}${name}_SHA256: [0-9a-f]{64}$`, 'm'));
  }
  // Cargo, rustup and Xcode build into this job's own folder, not caches CI keeps.
  for (const variable of ['CARGO_HOME', 'RUSTUP_HOME', 'CARGO_TARGET_DIR']) {
    assert.ok(text.includes(`echo "${variable}=$tools/`), `${variable} is not in the job's folder`);
  }
  assert.ok(text.includes('-derivedDataPath "$RELEASE_TOOLS/'), 'DerivedData is not the job’s own');
});
