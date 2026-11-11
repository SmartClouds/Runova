#!/usr/bin/env node
/**
 * Checks that no workflow script can stop on a sudo password prompt.
 *
 *   node scripts/workflow-sudo.mjs
 *
 * The self-hosted runners have no passwordless sudo, so a bare `sudo apt-get install` there fails
 * with "a terminal is required to read the password" and says nothing about what was missing.
 * Two rules, for every `run:` script under .github:
 *
 * - sudo is always `sudo -n`, so it fails at once instead of asking.
 * - a script that installs packages checks `sudo -n true` first, so it can name the packages
 *   for whoever looks after the runner (see the "X server" step in test.yml).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installCommand = /\b(?:apt-get|apt|dnf|yum)\s+(?:-\S+\s+)*install\b/;

/** Every `run:` script in a workflow or action file, with the line it starts on. */
export function runScripts(text) {
  const lines = text.split(/\r?\n/);
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(- )?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const keyColumn = match[1].length + (match[2] ? 2 : 0);
    const rest = match[3].trim();
    if (!/^[|>]/.test(rest)) {
      scripts.push({ line: i + 1, body: rest.replace(/^(['"])(.*)\1$/, '$2') });
      continue;
    }
    const body = [];
    let next = i + 1;
    for (; next < lines.length; next++) {
      const line = lines[next];
      if (line.trim() !== '' && line.length - line.trimStart().length <= keyColumn) break;
      body.push(line);
    }
    scripts.push({ line: i + 1, body: body.join('\n') });
    i = next - 1;
  }
  return scripts;
}

/** The script as the shell runs it, minus comments and quoted text (messages that mention sudo). */
function code(body) {
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'[^']*'/g, "''");
}

/** What is wrong with the sudo use in one workflow file, as "line: problem" strings. */
export function sudoProblems(text) {
  const problems = [];
  for (const { line, body } of runScripts(text)) {
    const shell = code(body);
    // sudo as a command (not inside a word such as workflow-sudo.mjs), without -n after it.
    if (/(?:^|[\s;&|(`])sudo(?:\s+(?!-n\b)|$)/m.test(shell)) {
      problems.push(`${line}: sudo without -n waits for a password the runner cannot type`);
    }
    if (installCommand.test(shell) && !/\bsudo -n true\b/.test(shell)) {
      problems.push(
        `${line}: installs packages without checking sudo -n true first, so it cannot say what to install`,
      );
    }
  }
  return problems;
}

/** The workflow and action files under .github. */
export function workflowFiles(repoRoot) {
  const github = join(repoRoot, '.github');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ya?ml$/.test(entry.name)) files.push(path);
    }
  };
  walk(github);
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let failed = false;
  for (const file of workflowFiles(repoRoot)) {
    for (const problem of sudoProblems(readFileSync(file, 'utf8'))) {
      console.error(`${relative(repoRoot, file).replaceAll('\\', '/')}:${problem}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log('No workflow script waits for a sudo password.');
}
