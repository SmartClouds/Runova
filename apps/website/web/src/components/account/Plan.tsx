import {
  Bitcoin,
  Check,
  CreditCard,
  Gauge,
  History,
  Receipt,
  Sparkles,
  Timer,
  Zap,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest, type Page, type Problem } from '@/lib/account/api';
import {
  type AccountPlan,
  type AccountType,
  cryptoPrice,
  intervalLabel,
  monitorsLabel,
  PAYMENT_STATUS_LABELS,
  type Payment,
  PROVIDER_LABELS,
  planEnds,
  price,
  yearlySaving,
} from '@/lib/billing';
import { cn } from '@/lib/utils';
import { AppRadio } from './fields';
import {
  Card,
  CardHeader,
  dateTime,
  EmptyState,
  LoadFailure,
  Notice,
  PageHeader,
  Pill,
  Rows,
  Shimmer,
  useLoad,
} from './ui';

type Way = 'month' | 'year' | 'crypto';

const WAYS: { value: Way; label: string; Icon: typeof CreditCard }[] = [
  { value: 'month', label: 'Monthly', Icon: CreditCard },
  { value: 'year', label: 'Yearly', Icon: CreditCard },
  { value: 'crypto', label: 'Crypto', Icon: Bitcoin },
];

/** The three things a type sets, as small tiles. */
function Limits({ type }: { type: AccountType }) {
  const tiles: { Icon: typeof Gauge; label: string; value: string }[] = [
    {
      Icon: Gauge,
      label: 'Online monitors',
      value: type.maxCloudMonitors === null ? 'Unlimited' : String(type.maxCloudMonitors),
    },
    { Icon: Timer, label: 'Fastest checks', value: intervalLabel(type.minIntervalSec) },
    { Icon: History, label: 'Detailed history', value: `${type.historyDays} days` },
  ];
  return (
    <dl className="grid gap-2 px-4 pb-4 sm:grid-cols-3 sm:px-5 sm:pb-5">
      {tiles.map(({ Icon, label, value }) => (
        <div
          key={label}
          className="rounded-inner bg-foreground/[0.04] p-3.5 ring-1 ring-foreground/[0.06] ring-inset"
        >
          <dt className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <Icon className="size-3.5" aria-hidden />
            {label}
          </dt>
          <dd className="mt-1 font-semibold text-lg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Segmented({
  value,
  options,
  onChange,
  label,
}: {
  value: Way;
  options: typeof WAYS;
  onChange: (value: Way) => void;
  label: string;
}) {
  return (
    <fieldset className="inline-flex rounded-full bg-foreground/[0.05] p-1 ring-1 ring-foreground/[0.08] ring-inset">
      <legend className="sr-only">{label}</legend>
      {options.map(({ value: option, label: text, Icon }) => (
        <label
          key={option}
          htmlFor={`plan-way-${option}`}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 font-medium text-sm transition-colors duration-[120ms] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-offset-2',
            value === option
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <AppRadio
            id={`plan-way-${option}`}
            name="plan-way"
            className="sr-only"
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
          />
          <Icon className="size-3.5" aria-hidden />
          {text}
        </label>
      ))}
    </fieldset>
  );
}

/** One type to buy, with its price for the way chosen. */
function Offer({
  type,
  way,
  months,
  current,
  busy,
  canBuy,
  onBuy,
}: {
  type: AccountType;
  way: Way;
  months: number;
  current: boolean;
  busy: boolean;
  /** False until the plan says how the account can pay, or when it can not pay at all. */
  canBuy: boolean;
  onBuy: () => void;
}) {
  const cents =
    way === 'crypto'
      ? cryptoPrice(type, months)
      : way === 'year'
        ? type.yearlyPriceCents
        : type.monthlyPriceCents;
  const per = way === 'crypto' ? `for ${months} ${months === 1 ? 'month' : 'months'}` : `a ${way}`;
  const saving = way === 'year' ? yearlySaving(type) : null;
  return (
    <li
      className={cn(
        'relative flex flex-col rounded-box p-5 ring-1 ring-inset transition-shadow',
        type.highlight
          ? 'bg-primary/[0.07] ring-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.15),0_18px_50px_-24px_hsl(var(--primary)/0.6)]'
          : 'bg-foreground/[0.03] ring-foreground/[0.08]',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-bold text-xl tracking-tight">{type.name}</h3>
        {type.highlight && (
          <Pill tone="primary">
            <Sparkles className="size-3" aria-hidden />
            Most picked
          </Pill>
        )}
      </div>
      {type.description && (
        <p className="mt-1.5 text-muted-foreground text-sm">{type.description}</p>
      )}
      <p className="mt-4 flex flex-wrap items-baseline gap-x-1.5">
        {cents === null ? (
          <span className="text-muted-foreground text-sm">Not sold this way</span>
        ) : (
          <>
            <span className="font-display font-bold text-3xl tracking-tight">
              {price(cents, type.currency)}
            </span>
            <span className="text-muted-foreground text-sm">{per}</span>
          </>
        )}
        {saving !== null && <Pill tone="success">Save {saving}%</Pill>}
      </p>
      <ul className="mt-4 grid flex-1 gap-2 text-sm">
        {(type.features.length > 0
          ? type.features
          : [monitorsLabel(type.maxCloudMonitors), `Checks ${intervalLabel(type.minIntervalSec)}`]
        ).map((line) => (
          <li key={line} className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <Button
        className="mt-5 w-full"
        variant={type.highlight ? 'default' : 'outline'}
        disabled={current || busy || !canBuy || cents === null}
        onClick={onBuy}
        aria-label={current ? `${type.name} is your plan` : `Get ${type.name}`}
      >
        {current ? 'Your plan' : busy ? 'Opening the checkout…' : `Get ${type.name}`}
      </Button>
    </li>
  );
}

function PaymentRow({ payment }: { payment: Payment }) {
  const tone =
    payment.status === 'paid' ? 'success' : payment.status === 'pending' ? 'warning' : 'neutral';
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">
          {payment.accountTypeName}
          {payment.months !== null &&
            ` · ${payment.months} ${payment.months === 1 ? 'month' : 'months'}`}
        </p>
        <p className="text-muted-foreground text-xs">
          {PROVIDER_LABELS[payment.provider]} · {dateTime(payment.createdAt)}
        </p>
      </div>
      <span className="font-medium font-mono text-sm tabular-nums">
        {price(payment.amountCents, payment.currency)}
      </span>
      <Pill tone={tone}>{PAYMENT_STATUS_LABELS[payment.status]}</Pill>
      {payment.invoiceUrl && (
        <a
          href={payment.invoiceUrl}
          className="font-medium text-primary text-sm hover:text-primary/80"
        >
          Pay now
        </a>
      )}
    </li>
  );
}

function Returned() {
  const [note, setNote] = useState<ReactNode>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') {
      setNote(
        <Notice tone="success" title="Thanks for subscribing">
          Your new plan shows here as soon as Stripe confirms the payment, usually within a minute.
        </Notice>,
      );
    } else if (params.get('crypto') === 'paid') {
      setNote(
        <Notice tone="success" title="Thanks for paying">
          Crypto payments are confirmed on the blockchain first. Your plan changes here once
          NOWPayments says it finished, and you get a notification.
        </Notice>,
      );
    } else if (params.get('checkout') === 'canceled' || params.get('crypto') === 'canceled') {
      setNote(<Notice title="Nothing was charged">You left the checkout before paying.</Notice>);
    }
  }, []);
  return note ? <div className="mb-4">{note}</div> : null;
}

/** The account's plan (E53): what it has, what it can buy and how, and what it paid. */
export default function Plan() {
  const plan = useLoad<AccountPlan>('/accounts/me/subscriptions/current');
  const types = useLoad<AccountType[]>('/account-types');
  const payments = useLoad<Page<Payment>>('/accounts/me/payments?pageSize=20');
  const [way, setWay] = useState<Way>('month');
  const [months, setMonths] = useState(1);
  const [busy, setBusy] = useState<number | 'portal' | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    if (plan.value && !plan.value.cardPayments && plan.value.cryptoPayments) setWay('crypto');
    if (plan.value?.cryptoMonths.length && !plan.value.cryptoMonths.includes(months)) {
      setMonths(plan.value.cryptoMonths[0] ?? 1);
    }
  }, [plan.value, months]);

  const go = async (path: string, body: unknown, key: number | 'portal') => {
    setBusy(key);
    setProblem(null);
    const response = await apiRequest<{ url: string }>(path, { method: 'POST', body });
    if (response.ok) {
      window.location.assign(response.value.url);
      return;
    }
    setBusy(null);
    setProblem(response.problem);
  };

  const buy = (type: AccountType) =>
    way === 'crypto'
      ? go('/accounts/me/crypto-invoices', { accountTypeId: type.id, months }, type.id)
      : go('/accounts/me/checkout-sessions', { accountTypeId: type.id, interval: way }, type.id);

  const current = plan.value;
  const ends = planEnds(current?.subscription ?? null);
  const paid = (types.value ?? []).filter((t) => !t.isFree);
  const ways = WAYS.filter((w) =>
    w.value === 'crypto' ? current?.cryptoPayments : current?.cardPayments,
  );
  const canBuy = ways.length > 0;

  return (
    <>
      <PageHeader
        title="Plan"
        description="Your plan sets how many monitors Runova checks online for you, and how often."
      />
      <Returned />
      <div className="grid gap-4">
        <Card>
          {plan.loading && !current ? (
            <Shimmer lines={3} />
          ) : plan.problem ? (
            <LoadFailure problem={plan.problem} retry={plan.reload} />
          ) : current ? (
            <>
              <CardHeader
                icon={<Zap />}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {current.accountType.name}
                    {current.subscription ? (
                      <Pill
                        tone={current.subscription.status === 'past_due' ? 'warning' : 'success'}
                      >
                        {current.subscription.status === 'past_due' ? 'Payment due' : 'Active'}
                      </Pill>
                    ) : (
                      <Pill>Free</Pill>
                    )}
                  </span>
                }
                description={
                  current.subscription
                    ? `${PROVIDER_LABELS[current.subscription.provider]}${ends ? ` · ${ends.label}` : ''}`
                    : 'Every account starts here. Pick a plan below for more monitors and faster checks.'
                }
                actions={
                  current.canManageCard && (
                    <Button
                      variant="outline"
                      disabled={busy === 'portal'}
                      onClick={() =>
                        go('/accounts/me/billing-portal-sessions', undefined, 'portal')
                      }
                    >
                      <CreditCard aria-hidden />
                      Manage subscription
                    </Button>
                  )
                }
              />
              {ends?.soon && (
                <div className="px-4 pb-3 sm:px-5">
                  <Notice tone="warning" title="Your plan ends soon">
                    Extend it below so your online monitors keep running. The time you buy is added
                    to the end date.
                  </Notice>
                </div>
              )}
              {current.subscription?.status === 'past_due' && (
                <div className="px-4 pb-3 sm:px-5">
                  <Notice tone="warning" title="Your last card payment failed">
                    Stripe tries again over the next days. Update your card from Manage subscription
                    to keep your plan.
                  </Notice>
                </div>
              )}
              <Limits type={current.accountType} />
            </>
          ) : null}
        </Card>

        <Card>
          <CardHeader
            icon={<Sparkles />}
            title="Choose a plan"
            description={
              canBuy
                ? 'Card plans renew by themselves and can be canceled any time. Crypto buys months up front.'
                : 'Payments are not open yet. Ask Runova support to move you to another plan.'
            }
            actions={
              canBuy && (
                <Segmented label="How to pay" value={way} options={ways} onChange={setWay} />
              )
            }
          />
          {problem && (
            <div className="px-4 pb-3 sm:px-5">
              <Notice tone="danger" title={problem.title}>
                {problem.detail}
              </Notice>
            </div>
          )}
          {way === 'crypto' && current && current.cryptoMonths.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 px-4 pb-4 sm:px-5">
              <span className="text-muted-foreground text-sm">Pay for</span>
              {current.cryptoMonths.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={months === m}
                  onClick={() => setMonths(m)}
                  className={cn(
                    'rounded-full px-3 py-1 font-medium text-sm ring-1 ring-inset transition-colors',
                    months === m
                      ? 'bg-primary/15 text-primary ring-primary/40'
                      : 'text-muted-foreground ring-foreground/10 hover:text-foreground',
                  )}
                >
                  {m} {m === 1 ? 'month' : 'months'}
                </button>
              ))}
            </div>
          )}
          {types.loading && !types.value ? (
            <Shimmer lines={4} />
          ) : (
            <ul className="grid gap-3 px-4 pb-4 sm:px-5 sm:pb-5 md:grid-cols-3">
              {paid.map((type) => (
                <Offer
                  key={type.id}
                  type={type}
                  way={way}
                  months={months}
                  current={
                    current?.accountType.id === type.id &&
                    current.subscription?.provider === 'stripe'
                  }
                  busy={busy === type.id}
                  canBuy={canBuy}
                  onBuy={() => void buy(type)}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader icon={<Receipt />} title="Payments" tone="neutral" />
          {payments.loading && !payments.value ? (
            <Shimmer lines={2} />
          ) : payments.value && payments.value.items.length > 0 ? (
            <Rows>
              {payments.value.items.map((payment) => (
                <PaymentRow key={payment.id} payment={payment} />
              ))}
            </Rows>
          ) : (
            <EmptyState icon={<Receipt />} title="No payments yet">
              What you pay, by card or crypto, shows here with its receipt status.
            </EmptyState>
          )}
        </Card>
      </div>
    </>
  );
}
