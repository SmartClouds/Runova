import { describe, expect, it } from 'vitest';
import {
  type AccountType,
  cryptoPrice,
  intervalLabel,
  monitorsLabel,
  planEnds,
  planLines,
  price,
  yearlySaving,
} from '../src/lib/billing';

const type = (patch: Partial<AccountType> = {}): AccountType => ({
  id: 3,
  key: 'pro',
  name: 'Pro',
  description: '',
  features: [],
  sortOrder: 2,
  isFree: false,
  isActive: true,
  highlight: true,
  maxCloudMonitors: 50,
  minIntervalSec: 60,
  historyDays: 90,
  encryptedItems: false,
  monthlyPriceCents: 1500,
  yearlyPriceCents: 15000,
  currency: 'usd',
  version: '1',
  ...patch,
});

describe('billing', () => {
  it('writes prices in their currency, without cents when whole', () => {
    expect(price(1500, 'usd')).toBe('$15');
    expect(price(1550, 'usd')).toBe('$15.50');
    expect(price(4900, 'eur')).toBe('€49');
    expect(price(0, 'usd')).toBe('$0');
  });

  it('says how often a monitor may be checked', () => {
    expect(intervalLabel(30)).toBe('every 30 seconds');
    expect(intervalLabel(60)).toBe('every minute');
    expect(intervalLabel(300)).toBe('every 5 minutes');
    expect(intervalLabel(3600)).toBe('every hour');
    expect(intervalLabel(7200)).toBe('every 2 hours');
  });

  it('counts monitors, with no limit as unlimited', () => {
    expect(monitorsLabel(1)).toBe('1 online monitor');
    expect(monitorsLabel(50)).toBe('50 online monitors');
    expect(monitorsLabel(null)).toBe('Unlimited online monitors');
  });

  it('adds the encrypted line only when the type has the flag, after the stored features', () => {
    const features = ['50 online monitors', 'Checks every minute'];
    expect(planLines(type({ features }))).toEqual(features);
    expect(planLines(type({ features, encryptedItems: true }))).toEqual([
      ...features,
      'Encrypted notifications and sync',
    ]);
    expect(planLines(type({ encryptedItems: true }))).toEqual([
      '50 online monitors',
      'Checks every minute',
      'Encrypted notifications and sync',
    ]);
    expect(features).toHaveLength(2);
  });

  it('prices months of crypto like the API does', () => {
    expect(cryptoPrice(type(), 1)).toBe(1500);
    expect(cryptoPrice(type(), 3)).toBe(4500);
    expect(cryptoPrice(type(), 12)).toBe(15000);
    expect(cryptoPrice(type({ yearlyPriceCents: null }), 12)).toBe(18000);
    expect(cryptoPrice(type({ monthlyPriceCents: null }), 3)).toBeNull();
  });

  it('works out what paying yearly saves, rounded to a whole percent', () => {
    expect(yearlySaving(type())).toBe(17);
    expect(yearlySaving(type({ yearlyPriceCents: 18000 }))).toBeNull();
    expect(yearlySaving(type({ yearlyPriceCents: null }))).toBeNull();
  });

  it('says when a plan ends or renews', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(planEnds(null, now)).toBeNull();
    expect(
      planEnds(
        {
          provider: 'stripe',
          currentPeriodEnd: '2026-12-06T12:00:00Z',
          cancelAtPeriodEnd: false,
          status: 'active',
        },
        now,
      ),
    ).toEqual({ label: 'Renews on Dec 6, 2026', soon: false });
    expect(
      planEnds(
        {
          provider: 'stripe',
          currentPeriodEnd: '2026-11-08T12:00:00Z',
          cancelAtPeriodEnd: true,
          status: 'active',
        },
        now,
      ),
    ).toEqual({ label: 'Ends on Nov 8, 2026', soon: true });
    expect(
      planEnds(
        { provider: 'manual', currentPeriodEnd: null, cancelAtPeriodEnd: false, status: 'active' },
        now,
      ),
    ).toEqual({ label: 'No end date', soon: false });
  });
});
