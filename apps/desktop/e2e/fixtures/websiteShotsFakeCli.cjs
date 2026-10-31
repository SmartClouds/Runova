#!/usr/bin/env node
// A stand-in for `gh` and `docker` in the website screenshots (e2e/websiteShots.e2e.ts), so the
// Pipelines and Docker pages show the made-up Northwind repos and containers. The answers come
// from the JSON file named in SHOTS_FAKE_CLI_DATA: { "gh": [answer...], "docker": [answer...] },
// where an answer is { "match": ["..."], "stdout": "...", "exitCode"?: 0 }. The first answer whose
// match strings all appear in the arguments wins; a call nothing matches fails, as a real CLI
// would on a bad command.
//
// Which tool it plays comes from its own file name (gh.exe, docker.exe, the way the spec compiles
// it on Windows, where execFile cannot start a .cmd), or from the first argument when it runs
// under Node (`node websiteShotsFakeCli.cjs gh ...`).
'use strict';

const { readFileSync } = require('node:fs');
const { basename } = require('node:path');

function toolAndArgs() {
  const exe = basename(process.execPath)
    .replace(/\.exe$/i, '')
    .toLowerCase();
  const args = process.argv.slice(2);
  if (exe === 'node' || exe === 'bun') return { tool: args[0] ?? '', args: args.slice(1) };
  return { tool: exe, args };
}

function main() {
  const { tool, args } = toolAndArgs();
  let answers = [];
  try {
    answers = JSON.parse(readFileSync(process.env.SHOTS_FAKE_CLI_DATA ?? '', 'utf8'))[tool] ?? [];
  } catch {
    // No data file: every call fails below.
  }
  const line = args.join(' ');
  const answer = answers.find((item) => item.match.every((part) => line.includes(part)));
  if (!answer) {
    process.stderr.write(`${tool}: no demo answer for "${line}"\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(answer.stdout ?? '');
  process.exitCode = answer.exitCode ?? 0;
}

main();
