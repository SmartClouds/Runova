/** `AccountTypeDto` (E53): what a type allows and costs. */
export interface AccountType {
  id: number;
  key: string;
  name: string;
  description: string;
  features: string[];
  sortOrder: number;
  isFree: boolean;
  isActive: boolean;
  highlight: boolean;
  /** null is unlimited. */
  maxCloudMonitors: number | null;
  minIntervalSec: number;
  historyDays: number;
  encryptedItems: boolean;
  monthlyPriceCents: number | null;
  yearlyPriceCents: number | null;
  currency: string;
  version: string;
}

export type Provider = 'stripe' | 'nowpayments' | 'manual';
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'expired';

export interface Subscription {
  id: number;
  accountTypeId: number;
  provider: Provider;
  status: SubscriptionStatus;
  startedAt: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
}

/** `GET /accounts/me/subscriptions/current`. */
export interface AccountPlan {
  accountType: AccountType;
  subscription: Subscription | null;
  cardPayments: boolean;
  cryptoPayments: boolean;
  cryptoMonths: number[];
  canManageCard: boolean;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired';

export interface Payment {
  id: number;
  provider: Provider;
  accountTypeId: number;
  accountTypeName: string;
  months: number | null;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  providerStatus: string | null;
  invoiceUrl: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface AdminPayment extends Omit<Payment, 'invoiceUrl'> {
  userId: number;
  email: string | null;
  orderId: string;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  stripe: 'Card',
  nowpayments: 'Crypto',
  manual: 'Given by Runova',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Waiting for payment',
  paid: 'Paid',
  failed: 'Failed',
  expired: 'Expired',
};

/** "$15", "$15.50", "€49": whole amounts without cents. */
export function price(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** "every 30 seconds", "every minute", "every 5 minutes", "every hour". */
export function intervalLabel(seconds: number): string {
  if (seconds < 60) return `every ${seconds} seconds`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
  }
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? 'every hour' : `every ${hours} hours`;
}

export function monitorsLabel(max: number | null): string {
  if (max === null) return 'Unlimited online monitors';
  return max === 1 ? '1 online monitor' : `${max} online monitors`;
}

export const ENCRYPTED_ITEMS_LINE = 'Encrypted notifications and sync';

/** The lines a plan card lists. The encrypted line comes from the type's flag, not from its stored features. */
export function planLines(type: AccountType): string[] {
  const lines =
    type.features.length > 0
      ? type.features
      : [monitorsLabel(type.maxCloudMonitors), `Checks ${intervalLabel(type.minIntervalSec)}`];
  return type.encryptedItems ? [...lines, ENCRYPTED_ITEMS_LINE] : lines;
}

/** What months of crypto cost: the yearly price for 12 when there is one, else monthly times months. */
export function cryptoPrice(type: AccountType, months: number): number | null {
  if (months === 12 && type.yearlyPriceCents !== null) return type.yearlyPriceCents;
  return type.monthlyPriceCents === null ? null : type.monthlyPriceCents * months;
}

/** The whole percent paying yearly saves over twelve months, or null when it saves nothing. */
export function yearlySaving(type: AccountType): number | null {
  if (type.yearlyPriceCents === null || type.monthlyPriceCents === null) return null;
  const full = type.monthlyPriceCents * 12;
  if (type.yearlyPriceCents >= full) return null;
  return Math.round((1 - type.yearlyPriceCents / full) * 100);
}

const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/** When a plan renews or ends, and whether that is within a week. */
export function planEnds(
  subscription: Pick<
    Subscription,
    'provider' | 'currentPeriodEnd' | 'cancelAtPeriodEnd' | 'status'
  > | null,
  now = new Date(),
): { label: string; soon: boolean } | null {
  if (!subscription) return null;
  if (!subscription.currentPeriodEnd) return { label: 'No end date', soon: false };
  const end = new Date(subscription.currentPeriodEnd);
  const renews = subscription.provider === 'stripe' && !subscription.cancelAtPeriodEnd;
  const soon = !renews && end.getTime() - now.getTime() < 7 * 86_400_000;
  return { label: `${renews ? 'Renews' : 'Ends'} on ${DAY.format(end)}`, soon };
}

/** The types a `GET /account-types` answer holds, or null when it is not that list. */
export function parseAccountTypes(value: unknown): AccountType[] | null {
  if (!Array.isArray(value)) return null;
  const types = value.filter(
    (item): item is AccountType =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as AccountType).id === 'number' &&
      typeof (item as AccountType).name === 'string' &&
      typeof (item as AccountType).minIntervalSec === 'number' &&
      Array.isArray((item as AccountType).features),
  );
  return types.length > 0 ? types : null;
}
