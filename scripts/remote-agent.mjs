#!/usr/bin/env node
/**
 * Runs the Runova Anywhere agent's .NET commands from `apps/remote-agent`, where its `global.json`
 * pins the SDK and the test runner (see scripts/website-api.mjs for why).
 *
 *   node scripts/remote-agent.mjs build | test | format | format:check | publish [rid]
 *
 * `publish` writes one self-contained RunovaAgent executable for the runtime (win-x64 by
 * default) into apps/desktop/build/remote-agent, which electron-builder.yml copies into the app.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = join(repoRoot, 'apps', 'remote-agent');
const solution = 'Runova.RemoteAgent.slnx';

function dotnet(args) {
  const result = spawnSync('dotnet', args, { cwd: agentRoot, stdio: 'inherit' });
  if (result.error) {
    console.error(`Could not run dotnet: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const commands = {
  build: () => dotnet(['build', solution, '--configuration', 'Release']),
  test: () => dotnet(['test', '--solution', solution]),
  format: () => dotnet(['format', solution]),
  'format:check': () => dotnet(['format', solution, '--verify-no-changes']),
  publish: () =>
    dotnet([
      'publish',
      'src/Runova.RemoteAgent/Runova.RemoteAgent.csproj',
      '--configuration',
      'Release',
      '--runtime',
      process.argv[3] ?? 'win-x64',
      '--output',
      join(repoRoot, 'apps', 'desktop', 'build', 'remote-agent'),
    ]),
};

const name = process.argv[2];
const command = name ? commands[name] : undefined;
if (!command) {
  console.error(`Usage: node scripts/remote-agent.mjs <${Object.keys(commands).join(' | ')}>`);
  process.exit(2);
}
command();
