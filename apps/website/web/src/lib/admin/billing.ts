import type { AccountType } from '../billing';

/** The account type form: every number as typed, so a half-typed field is not lost. */
export interface AccountTypeForm {
  key: string;
  name: string;
  description: string;
  /** One line per feature. */
  features: string;
  sortOrder: string;
  isActive: boolean;
  highlight: boolean;
  /** Empty is unlimited. */
  maxCloudMonitors: string;
  minIntervalSec: string;
  historyDays: string;
  encryptedItems: boolean;
  /** In whole units with up to two decimals, such as 15 or 4.99; empty is no price. */
  monthlyPrice: string;
  yearlyPrice: string;
  currency: string;
}

export const emptyAccountTypeForm = (): AccountTypeForm => ({
  key: '',
  name: '',
  description: '',
  features: '',
  sortOrder: '10',
  isActive: true,
  highlight: false,
  maxCloudMonitors: '10',
  minIntervalSec: '300',
  historyDays: '30',
  encryptedItems: false,
  monthlyPrice: '',
  yearlyPrice: '',
  currency: 'usd',
});

const units = (cents: number | null) =>
  cents === null ? '' : cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);

export const fromAccountType = (type: AccountType): AccountTypeForm => ({
  key: type.key,
  name: type.name,
  description: type.description,
  features: type.features.join('\n'),
  sortOrder: String(type.sortOrder),
  isActive: type.isActive,
  highlight: type.highlight,
  maxCloudMonitors: type.maxCloudMonitors === null ? '' : String(type.maxCloudMonitors),
  minIntervalSec: String(type.minIntervalSec),
  historyDays: String(type.historyDays),
  encryptedItems: type.encryptedItems,
  monthlyPrice: units(type.monthlyPriceCents),
  yearlyPrice: units(type.yearlyPriceCents),
  currency: type.currency,
});

/**
 * A whole number, or the text as typed: the API then names the field. (NaN would not do, since
 * JSON writes it as null, which means unlimited for monitors.)
 */
const whole = (value: string): number | string =>
  /^\d+$/.test(value.trim()) ? Number(value.trim()) : value.trim();

/** "15" or "4.99" as cents; empty is null; anything else the text as typed, for the API to name. */
export function toCents(value: string): number | string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return trimmed;
  return Math.round(Number(trimmed) * 100);
}

/** The body of a create or a patch. The key goes only on create, since it never changes. */
export function accountTypeBody(form: AccountTypeForm, creating: boolean, isFree: boolean) {
  const max = form.maxCloudMonitors.trim();
  return {
    ...(creating && { key: form.key.trim() }),
    name: form.name.trim(),
    description: form.description.trim(),
    features: form.features
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    sortOrder: whole(form.sortOrder),
    ...(!isFree && { isActive: form.isActive }),
    highlight: form.highlight,
    maxCloudMonitors: max === '' ? null : whole(max),
    minIntervalSec: whole(form.minIntervalSec),
    historyDays: whole(form.historyDays),
    encryptedItems: form.encryptedItems,
    ...(!isFree && {
      monthlyPriceCents: toCents(form.monthlyPrice),
      yearlyPriceCents: toCents(form.yearlyPrice),
    }),
    currency: form.currency.trim().toLowerCase(),
  };
}

/** `PaymentSettingsDto`. Secrets never come back, only whether one is saved. */
export interface PaymentSettings {
  stripeEnabled: boolean;
  stripePublishableKey: string | null;
  hasStripeSecretKey: boolean;
  hasStripeWebhookSecret: boolean;
  stripeWebhookUrl: string;
  nowPaymentsEnabled: boolean;
  hasNowPaymentsApiKey: boolean;
  hasNowPaymentsIpnSecret: boolean;
  nowPaymentsSandbox: boolean;
  nowPaymentsIpnUrl: string;
  cryptoMonths: number[];
  updatedAt: string | null;
  version: string;
}

/** The settings form. Secrets start empty: typed means replace. */
export interface PaymentSettingsForm {
  stripeEnabled: boolean;
  stripePublishableKey: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  nowPaymentsEnabled: boolean;
  nowPaymentsApiKey: string;
  nowPaymentsIpnSecret: string;
  nowPaymentsSandbox: boolean;
  cryptoMonths: number[];
}

export const fromPaymentSettings = (settings: PaymentSettings): PaymentSettingsForm => ({
  stripeEnabled: settings.stripeEnabled,
  stripePublishableKey: settings.stripePublishableKey ?? '',
  stripeSecretKey: '',
  stripeWebhookSecret: '',
  nowPaymentsEnabled: settings.nowPaymentsEnabled,
  nowPaymentsApiKey: '',
  nowPaymentsIpnSecret: '',
  nowPaymentsSandbox: settings.nowPaymentsSandbox,
  cryptoMonths: settings.cryptoMonths,
});

/** The merge patch for a save. A secret goes only when one was typed. */
export function paymentSettingsBody(form: PaymentSettingsForm) {
  const secret = (name: keyof PaymentSettingsForm, value: string) =>
    value.trim() ? { [name]: value.trim() } : {};
  return {
    stripeEnabled: form.stripeEnabled,
    stripePublishableKey: form.stripePublishableKey.trim() || null,
    ...secret('stripeSecretKey', form.stripeSecretKey),
    ...secret('stripeWebhookSecret', form.stripeWebhookSecret),
    nowPaymentsEnabled: form.nowPaymentsEnabled,
    ...secret('nowPaymentsApiKey', form.nowPaymentsApiKey),
    ...secret('nowPaymentsIpnSecret', form.nowPaymentsIpnSecret),
    nowPaymentsSandbox: form.nowPaymentsSandbox,
    cryptoMonths: [...form.cryptoMonths].sort((a, b) => a - b),
  };
}
