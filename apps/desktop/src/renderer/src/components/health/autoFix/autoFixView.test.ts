import { describe, expect, it } from 'vitest';
import { target } from '../testing/fixtures';
import {
  canAutoFix,
  deployAppRoute,
  deployContext,
  workspaceRunArgs,
  workspaceRunLabel,
} from './autoFixView';

/** Monitoring's Auto fix: the flags, the tab label and the Deploy link, without any drawing. */

describe('canAutoFix', () => {
  it('offers a fix only for a monitor that is down or degraded', () => {
    expect(canAutoFix({ state: 'fail' })).toBe(true);
    expect(canAutoFix({ state: 'unreachable' })).toBe(true);
    expect(canAutoFix({ state: 'warn' })).toBe(true);
    expect(canAutoFix({ state: 'pass' })).toBe(false);
    expect(canAutoFix({ state: 'paused' })).toBe(false);
    expect(canAutoFix({ state: 'pending' })).toBe(false);
  });
});

describe('workspaceRunArgs', () => {
  it('puts the model, the effort and the permission mode on the command line', () => {
    expect(
      workspaceRunArgs({
        cliId: 'claude-code',
        model: 'opus',
        effort: 'high',
        mode: 'acceptEdits',
      }),
    ).toEqual(['--model', 'opus', '--effort', 'high', '--permission-mode', 'acceptEdits']);
  });

  it("uses each CLI's own flags", () => {
    expect(workspaceRunArgs({ cliId: 'codex-cli', effort: 'high', mode: 'read-only' })).toEqual([
      '-c',
      'model_reasoning_effort=high',
      '--sandbox',
      'read-only',
    ]);
  });

  it('adds nothing for what was left unset, or a mode the CLI does not have', () => {
    expect(workspaceRunArgs({ cliId: 'claude-code' })).toEqual([]);
    expect(workspaceRunArgs({ cliId: 'claude-code', model: '  ', mode: 'nope' })).toEqual([]);
    expect(workspaceRunArgs({ cliId: 'no-such-cli', model: 'opus' })).toEqual([]);
  });
});

describe('workspaceRunLabel', () => {
  it('reads the pick in words for the tab', () => {
    expect(
      workspaceRunLabel({ cliId: 'claude-code', model: 'opus', effort: 'high', mode: 'plan' }),
    ).toBe('Opus 5.5 · High · Plan');
    expect(workspaceRunLabel({ cliId: 'claude-code', mode: 'bypassPermissions' })).toBe(
      'Bypass permissions',
    );
    expect(workspaceRunLabel({ cliId: 'claude-code' })).toBeUndefined();
  });
});

describe('deployAppRoute', () => {
  it("opens the app's page on its server", () => {
    expect(deployAppRoute({ serverId: 'srv 1', stackId: 'stack-9' })).toBe(
      '/deploy?server=srv+1&view=apps&app=stack-9',
    );
  });
});

describe('deployContext', () => {
  it('tells the Deploy AI what is wrong and where', () => {
    expect(
      deployContext(target({ state: 'fail', headline: 'postgres: connection refused' })),
    ).toEqual({
      title: 'Down: API',
      facts: [
        'Monitored at https://api.example.com/_runova/health?probe=1',
        'postgres: connection refused',
      ],
    });
    expect(deployContext(target({ state: 'warn', headline: null })).facts).toHaveLength(1);
  });
});
