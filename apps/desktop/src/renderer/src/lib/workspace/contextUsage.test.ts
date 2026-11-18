import { describe, expect, it } from 'vitest';
import {
  contextHotTokens,
  contextLeftLabel,
  contextLevel,
  contextPercent,
  contextPercentLabel,
  contextUsedLabel,
} from './contextUsage';

const usage = (tokens: number, window = 200_000) => ({ tokens, window });

describe('contextPercent', () => {
  it('rounds the share of the window to a whole percent', () => {
    expect(contextPercent(usage(84_100))).toBe(42);
    expect(contextPercent(usage(84_900))).toBe(42);
    expect(contextPercent(usage(85_000))).toBe(43);
    expect(contextPercent(usage(500_000, 1_000_000))).toBe(50);
  });

  it('stays between 0 and 100', () => {
    expect(contextPercent(usage(0))).toBe(0);
    expect(contextPercent(usage(260_000))).toBe(100);
  });
});

describe('contextPercentLabel', () => {
  it('shows a percent, and a sliver under 1% rather than a misleading 0%', () => {
    expect(contextPercentLabel(usage(84_100))).toBe('42%');
    expect(contextPercentLabel(usage(500))).toBe('<1%');
    expect(contextPercentLabel(usage(0))).toBe('0%');
  });
});

describe('contextLevel', () => {
  it('warms from 60% and turns hot from 85%', () => {
    expect(contextLevel(usage(118_000))).toBe('calm');
    expect(contextLevel(usage(120_000))).toBe('warm');
    expect(contextLevel(usage(168_000))).toBe('warm');
    expect(contextLevel(usage(170_000))).toBe('hot');
  });

  it('puts the hot mark where the ring turns hot', () => {
    expect(contextHotTokens(usage(1, 200_000))).toBe(170_000);
    expect(contextHotTokens(usage(1, 1_000_000))).toBe(850_000);
  });
});

describe('context labels', () => {
  it('says what is used out of the window', () => {
    expect(contextUsedLabel(usage(84_100))).toBe('84.1K of 200K tokens used');
    expect(contextUsedLabel(usage(412_000, 1_000_000))).toBe('412K of 1M tokens used');
  });

  it('says what is left, never less than nothing', () => {
    expect(contextLeftLabel(usage(84_100))).toBe('115.9K left');
    expect(contextLeftLabel(usage(260_000))).toBe('0 left');
  });
});
