#!/usr/bin/env node
// A stand-in for Claude Code in the version bump e2e (e2e/versionBumpLog.e2e.ts). Asked for
// stream-json, it reports its steps one event at a time the way the real CLI does, sets the
// version in package.json, and then holds the run open until the test drops a `bump-gate` file
// next to the project folder, so the live log can be looked at while the run is still going.
// Any other headless run gets a short plain answer.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const assistant = (...content) => send({ type: 'assistant', message: { content } });
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${name}`, name, input });

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', async () => {
  if (!args.includes('stream-json')) {
    process.stdout.write('feat: e2e change\n');
    return;
  }
  const version = prompt.match(/Update the version to (\S+?) in every file/)?.[1] ?? '0.0.0';
  const manifest = path.join(process.cwd(), 'package.json');
  const gate = path.join(process.cwd(), '..', 'bump-gate');

  send({ type: 'system', subtype: 'init', cwd: process.cwd() });
  await wait(150);
  assistant({ type: 'text', text: 'Looking for every file that carries a version.' });
  await wait(150);
  assistant(tool('Glob', { pattern: '**/package.json' }));
  await wait(150);
  assistant(tool('Read', { file_path: manifest }));
  await wait(150);
  assistant(tool('Edit', { file_path: manifest }));
  fs.writeFileSync(manifest, `{ "version": "${version}" }\n`);
  await wait(150);
  assistant(tool('Bash', { command: 'git status --short' }));
  send({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', is_error: true, content: 'Permission to use Bash denied.' }],
    },
  });

  for (let waited = 0; !fs.existsSync(gate) && waited < 90_000; waited += 100) await wait(100);

  const summary = `package.json: 1.0.0 -> ${version}`;
  assistant({ type: 'text', text: summary });
  send({ type: 'result', subtype: 'success', is_error: false, result: summary });
});
