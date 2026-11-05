#!/usr/bin/env node
/**
 * Runs the website API and the website dev server side by side in this terminal, with each line
 * marked [api] or [web]. run-website.bat starts PostgreSQL and sets the environment first.
 * When either one stops, or you press Ctrl+C, both stop.
 *
 *   node scripts/website-local.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = join(repoRoot, 'apps', 'website', 'api');

// Keep the colors even though the output goes through a pipe.
const env = {
  ...process.env,
  FORCE_COLOR: '1',
  DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION: '1',
};

const colors = { api: '\x1b[35m', web: '\x1b[36m' };
const children = [];
let stopping = false;

function prefix(name, stream, out) {
  const tag = `${colors[name]}[${name}]\x1b[0m `;
  createInterface({ input: stream }).on('line', (line) => out.write(`${tag}${line}\n`));
}

function run(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  prefix(name, child.stdout, process.stdout);
  prefix(name, child.stderr, process.stderr);
  child.on('error', (error) => {
    console.error(`[${name}] could not start ${command}: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[${name}] stopped (${code ?? signal}), stopping the other one.`);
    stop(code ?? 1);
  });
  children.push(child);
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    // `dotnet run` and bun start their own children, so the whole tree has to go.
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGINT');
    }
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));

run('api', 'dotnet', ['run', '--project', join('src', 'Runova.Website.Api')], apiRoot);
run('web', process.execPath, [join(repoRoot, 'scripts', 'website.mjs'), 'dev'], repoRoot);
