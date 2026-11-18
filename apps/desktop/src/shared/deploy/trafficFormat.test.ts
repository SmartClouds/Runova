import { describe, expect, it } from 'vitest';
import type { TrafficTotals } from './protocol/generated/Runova.ServerCore.Contracts';
import {
  botShare,
  bounceRate,
  changeOf,
  changeText,
  compactNumber,
  countryName,
  formatBytes,
  formatDuration,
  formatMs,
  formatShare,
  pagesPerVisit,
  sourcesText,
  visitLength,
} from './trafficFormat';

const TOTALS: TrafficTotals = {
  visitors: 1200,
  visits: 1600,
  pageViews: 4800,
  requests: 20_000,
  botRequests: 5000,
  bytes: 3_565_158_400,
  bounces: 640,
  visitSeconds: 1600 * 125,
  status2xx: 18_000,
  status3xx: 1000,
  status4xx: 900,
  status5xx: 100,
  averageResponseMs: 42.4,
  p95ResponseMs: 310,
};

describe('compactNumber', () => {
  it('writes small numbers in full and big ones short', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(7)).toBe('7');
    expect(compactNumber(1284)).toBe('1,284');
    expect(compactNumber(9999)).toBe('9,999');
    expect(compactNumber(12_900)).toBe('12.9K');
    expect(compactNumber(129_000)).toBe('129K');
    expect(compactNumber(3_400_000)).toBe('3.4M');
    expect(compactNumber(2_000_000_000)).toBe('2B');
  });

  it('rounds fractions it is handed and keeps the sign', () => {
    expect(compactNumber(12.6)).toBe('13');
    expect(compactNumber(-25_000)).toBe('-25K');
    expect(compactNumber(Number.NaN)).toBe('0');
  });
});

describe('formatBytes', () => {
  it('uses the unit that keeps the number short', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3482)).toBe('3.4 KB');
    expect(formatBytes(3_565_158)).toBe('3.4 MB');
    expect(formatBytes(48_000_000)).toBe('46 MB');
    expect(formatBytes(3_565_158_400)).toBe('3.3 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2 TB');
    expect(formatBytes(-1)).toBe('0 B');
  });
});

describe('formatDuration', () => {
  it('reads as seconds, minutes or hours', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45.4)).toBe('45s');
    expect(formatDuration(125)).toBe('2m 05s');
    expect(formatDuration(3840)).toBe('1h 04m');
  });
});

describe('formatMs', () => {
  it('keeps milliseconds under a second and seconds above', () => {
    expect(formatMs(0.4)).toBe('<1 ms');
    expect(formatMs(42.4)).toBe('42 ms');
    expect(formatMs(1420)).toBe('1.4 s');
  });
});

describe('formatShare', () => {
  it('gives a decimal only to small shares', () => {
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.042)).toBe('4.2%');
    expect(formatShare(0.4)).toBe('40%');
    expect(formatShare(1)).toBe('100%');
  });
});

describe('figures from the totals', () => {
  it('works out bounce rate, pages per visit, visit length and bot share', () => {
    expect(bounceRate(TOTALS)).toBeCloseTo(0.4);
    expect(pagesPerVisit(TOTALS)).toBe(3);
    expect(visitLength(TOTALS)).toBe(125);
    expect(botShare(TOTALS)).toBe(0.25);
  });

  it('is zero rather than NaN with no visits or requests', () => {
    const none = { ...TOTALS, visits: 0, requests: 0 };
    expect(bounceRate(none)).toBe(0);
    expect(pagesPerVisit(none)).toBe(0);
    expect(visitLength(none)).toBe(0);
    expect(botShare(none)).toBe(0);
  });
});

describe('changeOf', () => {
  it('compares with the period before', () => {
    expect(changeOf(120, 100)).toEqual({ direction: 'up', ratio: 0.2 });
    expect(changeOf(75, 100)).toEqual({ direction: 'down', ratio: -0.25 });
    expect(changeOf(100, 100)).toEqual({ direction: 'flat', ratio: 0 });
  });

  it('calls growth from nothing new, and says nothing without a period before', () => {
    expect(changeOf(5, 0)).toEqual({ direction: 'up', ratio: null });
    expect(changeOf(0, 0)).toEqual({ direction: 'flat', ratio: 0 });
    expect(changeOf(5, undefined)).toBeNull();
  });

  it('treats a change under half a percent as flat', () => {
    expect(changeOf(1001, 1000)).toEqual({ direction: 'flat', ratio: 0.001 });
  });
});

describe('changeText', () => {
  it('signs the percentage', () => {
    expect(changeText({ direction: 'up', ratio: 0.2 })).toBe('+20%');
    expect(changeText({ direction: 'down', ratio: -0.034 })).toBe('-3.4%');
    expect(changeText({ direction: 'flat', ratio: 0 })).toBe('No change');
    expect(changeText({ direction: 'up', ratio: null })).toBe('New');
    expect(changeText({ direction: 'up', ratio: 12.5 })).toBe('+1,250%');
  });
});

describe('countryName', () => {
  it('names a country from its code, and the two special ones', () => {
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('us')).toBe('United States');
    expect(countryName('XX')).toBe('Unknown');
    expect(countryName('Unknown')).toBe('Unknown');
    expect(countryName('T1')).toBe('Tor');
    expect(countryName('Other')).toBe('Other');
  });
});

describe('sourcesText', () => {
  it('says where the countries came from, leaving out empty sources', () => {
    expect(sourcesText({ cloudflare: 82, dbIp: 18, unknown: 0 })).toBe(
      '82% from Cloudflare, 18% from DB-IP',
    );
    expect(sourcesText({ cloudflare: 0, dbIp: 90, unknown: 10 })).toBe(
      '90% from DB-IP, 10% unknown',
    );
    expect(sourcesText({ cloudflare: 0, dbIp: 0, unknown: 0 })).toBeNull();
  });
});
