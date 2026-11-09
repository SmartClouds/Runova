import { describe, expect, it } from 'vitest';
import {
  accountTypeBody,
  emptyAccountTypeForm,
  fromAccountType,
  fromPaymentSettings,
  paymentSettingsBody,
  toCents,
} from '../src/lib/admin/billing';
import type { AccountType } from '../src/lib/billing';

const pro: AccountType = {
  id: 3,
  key: 'pro',
  name: 'Pro',
  description: 'Every project.',
  features: ['50 online monitors', 'Checks every minute'],
  sortOrder: 2,
  isFree: false,
  isActive: true,
  highlight: true,
  maxCloudMonitors: 50,
  minIntervalSec: 60,
  historyDays: 90,
  encryptedItems: true,
  monthlyPriceCents: 1500,
  yearlyPriceCents: 14999,
  currency: 'usd',
  version: '9',
};

describe('account type form', () => {
  it('reads prices as whole units and cents back', () => {
    expect(toCents('15')).toBe(1500);
    expect(toCents('4.99')).toBe(499);
    expect(toCents(' 0.5 ')).toBe(50);
    expect(toCents('')).toBeNull();
    expect(toCents('4.999')).toBe('4.999');
    expect(toCents('-1')).toBe('-1');
  });

  it('round-trips a type', () => {
    const form = fromAccountType(pro);
    expect(form.monthlyPrice).toBe('15');
    expect(form.yearlyPrice).toBe('149.99');
    expect(form.features).toBe('50 online monitors\nChecks every minute');
    expect(accountTypeBody(form, false, false)).toEqual({
      name: 'Pro',
      description: 'Every project.',
      features: ['50 online monitors', 'Checks every minute'],
      sortOrder: 2,
      isActive: true,
      highlight: true,
      maxCloudMonitors: 50,
      minIntervalSec: 60,
      historyDays: 90,
      encryptedItems: true,
      monthlyPriceCents: 1500,
      yearlyPriceCents: 14999,
      currency: 'usd',
    });
  });

  it('sends the key only when making a type, and empty monitors as unlimited', () => {
    const form = { ...emptyAccountTypeForm(), key: ' team ', name: 'Team', maxCloudMonitors: '' };
    const body = accountTypeBody(form, true, false);
    expect(body.key).toBe('team');
    expect(body.maxCloudMonitors).toBeNull();
    expect(accountTypeBody(form, false, false)).not.toHaveProperty('key');
  });

  it('never sends a price or archiving for the free type', () => {
    const body = accountTypeBody(fromAccountType({ ...pro, isFree: true }), false, true);
    expect(body).not.toHaveProperty('monthlyPriceCents');
    expect(body).not.toHaveProperty('isActive');
  });

  it('leaves a bad number for the API to name', () => {
    const body = accountTypeBody(
      { ...emptyAccountTypeForm(), minIntervalSec: 'fast' },
      true,
      false,
    );
    expect(body.minIntervalSec).toBe('fast');
  });
});

describe('payment settings form', () => {
  const saved = {
    stripeEnabled: true,
    stripePublishableKey: 'pk_test',
    hasStripeSecretKey: true,
    hasStripeWebhookSecret: true,
    stripeWebhookUrl: 'https://runovahq.com/api/v1/stripe-events',
    nowPaymentsEnabled: false,
    hasNowPaymentsApiKey: false,
    hasNowPaymentsIpnSecret: false,
    nowPaymentsSandbox: true,
    nowPaymentsIpnUrl: 'https://runovahq.com/api/v1/nowpayments-events',
    cryptoMonths: [1, 3, 12],
    updatedAt: null,
    version: '3',
  };

  it('sends a secret only when one was typed', () => {
    const body = paymentSettingsBody(fromPaymentSettings(saved));
    expect(body).not.toHaveProperty('stripeSecretKey');
    expect(body).not.toHaveProperty('nowPaymentsIpnSecret');
    expect(body.stripePublishableKey).toBe('pk_test');
  });

  it('trims typed secrets and sorts the periods', () => {
    const form = {
      ...fromPaymentSettings(saved),
      nowPaymentsApiKey: ' key ',
      cryptoMonths: [12, 1],
    };
    const body = paymentSettingsBody(form);
    expect(body).toMatchObject({ nowPaymentsApiKey: 'key', cryptoMonths: [1, 12] });
  });
});
