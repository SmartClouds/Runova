import { describe, expect, it } from 'vitest';
import { cliLiveSwitch, launchEffort } from './liveSwitch.js';

describe('cliLiveSwitch', () => {
  it('switches Claude Code with slash commands that take the value', () => {
    const live = cliLiveSwitch('claude-code');
    expect(live?.model?.('sonnet')).toBe('/model sonnet');
    expect(live?.effort?.('xhigh')).toBe('/effort xhigh');
  });

  it('has nothing for CLIs whose /model only opens a picker', () => {
    expect(cliLiveSwitch('codex-cli')).toBeNull();
    expect(cliLiveSwitch('gemini-cli')).toBeNull();
    expect(cliLiveSwitch(undefined)).toBeNull();
  });
});

describe('launchEffort', () => {
  it('reads the effort flag from a launch command', () => {
    expect(launchEffort('claude --model opus --effort high\r')).toBe('high');
    expect(launchEffort('claude --effort=max')).toBe('max');
  });

  it('takes the last effort flag', () => {
    expect(launchEffort('claude --effort low --effort medium')).toBe('medium');
  });

  it('ignores a missing or unknown effort', () => {
    expect(launchEffort('claude --model opus')).toBeUndefined();
    expect(launchEffort('claude --effort huge')).toBeUndefined();
    expect(launchEffort('claude --effort')).toBeUndefined();
    expect(launchEffort(undefined)).toBeUndefined();
  });
});
