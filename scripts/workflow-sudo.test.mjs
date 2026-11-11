import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScripts, sudoProblems, workflowFiles } from './workflow-sudo.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The step that broke the Anywhere agent job on the self-hosted runners (CI run 431).
const passwordPrompt = `
jobs:
  remote-agent:
    steps:
      - name: X server for the Linux screen and input test
        run: |
          # The self-hosted runner keeps what it installed, so only reach for apt when needed.
          command -v Xvfb > /dev/null && command -v xsetroot > /dev/null || {
            sudo apt-get update
            sudo apt-get install -y xvfb x11-xserver-utils libx11-6 libxext6 libxtst6
          }
          Xvfb :97 -screen 0 1024x768x24 -ac -noreset &
      - name: Tests
        run: dotnet test
`;

const guarded = `
    steps:
      - name: Packages
        run: |
          if ! sudo -n true 2> /dev/null; then
            echo "::error::This runner has no passwordless sudo, so run: sudo apt-get install -y xvfb"
            exit 1
          fi
          sudo -n apt-get update
          sudo -n apt-get install -y xvfb
`;

test('reads block and one-line run scripts, and where each ends', () => {
  const scripts = runScripts(passwordPrompt);
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0].line, 6);
  assert.match(scripts[0].body, /Xvfb :97/);
  assert.doesNotMatch(scripts[0].body, /dotnet test/);
  assert.equal(scripts[1].body, 'dotnet test');
});

test('flags the step that asked for a sudo password in CI run 431', () => {
  assert.deepEqual(sudoProblems(passwordPrompt), [
    '6: sudo without -n waits for a password the runner cannot type',
    '6: installs packages without checking sudo -n true first, so it cannot say what to install',
  ]);
});

test('accepts sudo -n behind a check that names the packages', () => {
  assert.deepEqual(sudoProblems(guarded), []);
});

test('ignores sudo in comments and in the messages it prints', () => {
  const text = `
      - run: |
          # sudo apt-get install -y ffmpeg would ask for a password here
          echo "::warning::Install it on the runner host (sudo apt-get install -y ffmpeg)."
`;
  assert.deepEqual(sudoProblems(text), []);
});

test('only counts sudo as a command, wherever it starts', () => {
  assert.deepEqual(sudoProblems('        run: node --test scripts/workflow-sudo.test.mjs\n'), []);
  assert.equal(sudoProblems('        run: true && sudo rm -rf /tmp/x\n').length, 1);
  assert.equal(sudoProblems('        run: out=$(sudo cat /etc/shadow)\n').length, 1);
});

test('flags a one-line sudo and a quoted one-line install', () => {
  assert.deepEqual(sudoProblems('      - run: sudo mdutil -a -i off || true\n'), [
    '1: sudo without -n waits for a password the runner cannot type',
  ]);
  assert.equal(sudoProblems('        run: "sudo -n apt-get install -y libfuse2"\n').length, 1);
});

test('no workflow in the repository waits for a sudo password', () => {
  const files = workflowFiles(repoRoot);
  assert.ok(files.some((file) => file.endsWith('test.yml')));
  const problems = files.flatMap((file) =>
    sudoProblems(readFileSync(file, 'utf8')).map((problem) => `${file}:${problem}`),
  );
  assert.deepEqual(problems, []);
});
