import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest, type Problem } from '@/lib/admin/api';
import {
  fromPaymentSettings,
  type PaymentSettings,
  type PaymentSettingsForm,
  paymentSettingsBody,
} from '@/lib/admin/billing';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import { ConflictDialog } from './ConflictDialog';
import { CopyField } from './CopyField';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { SecretField, Switch } from './SecretField';

const PATH = '/payment-settings';
const PERIODS = [1, 3, 6, 12, 24];

interface Check {
  ok: boolean;
  detail: string;
}

function ConnectionCheck({
  provider,
  disabled,
}: {
  provider: 'stripe' | 'nowpayments';
  disabled: boolean;
}) {
  const [result, setResult] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          const response = await apiRequest<Check>('/payment-connection-checks', {
            method: 'POST',
            body: { provider },
          });
          setBusy(false);
          setResult(
            response.ok
              ? response.value
              : { ok: false, detail: response.problem.detail || response.problem.title },
          );
        }}
      >
        {busy ? 'Checking…' : 'Check the saved keys'}
      </Button>
      {result && (
        <p
          role="status"
          className={
            result.ok ? 'font-medium text-sm text-success' : 'font-medium text-destructive text-sm'
          }
        >
          {result.detail}
        </p>
      )}
    </div>
  );
}

/**
 * Card payments (Stripe) and crypto (NOWPayments), for Admins (E53). A provider can only be on
 * with its keys, which are never shown again once saved.
 */
export default function PaymentSettingsEditor() {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [form, setForm] = useState<PaymentSettingsForm | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const saving = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLDivElement>(null);

  const show = useCallback((next: PaymentSettings) => {
    setSettings(next);
    setForm(fromPaymentSettings(next));
  }, []);

  const load = useCallback(async () => {
    const response = await apiRequest<PaymentSettings>(PATH);
    if (response.ok) show(response.value);
    else setProblem(response.problem);
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  if (!settings || !form) {
    return problem ? (
      <ErrorSummary problem={problem} summaryRef={summary} />
    ) : (
      <p className="text-muted-foreground text-sm">Loading the payment settings…</p>
    );
  }

  const set = (patch: Partial<PaymentSettingsForm>) => {
    setMessage(null);
    setForm((current) => (current ? { ...current, ...patch } : current));
  };

  const save = async (version = settings.version) => {
    if (saving.current) return;
    saving.current = true;
    const response = await apiRequest<PaymentSettings>(PATH, {
      method: 'PATCH',
      body: paymentSettingsBody(form),
      ifMatch: `"${version}"`,
    });
    saving.current = false;
    if (response.ok) {
      show(response.value);
      setProblem(null);
      setErrors({});
      setMessage('Saved.');
      return;
    }
    if (response.problem.status === 412) {
      setConflict(response.problem.currentVersion ?? null);
      return;
    }
    setErrors(response.problem.errors);
    setProblem(response.problem);
  };

  const fieldErrors = (name: string) =>
    errorsFor(errors, name).map((text) => (
      <p key={text} className="font-medium text-destructive text-sm">
        {text}
      </p>
    ));

  return (
    <form
      noValidate
      className="grid max-w-2xl gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <ErrorSummary problem={problem} summaryRef={summary} />

      <section className="grid gap-4 rounded-box border p-5" aria-labelledby="stripe-heading">
        <div>
          <h2 id="stripe-heading" className="font-semibold text-lg">
            Card payments (Stripe)
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            Stripe Checkout sells each paid type monthly or yearly, and renews it. In the Stripe
            dashboard copy the API keys, add a webhook endpoint at the address below for{' '}
            <code className="font-mono text-xs">customer.subscription.*</code>,{' '}
            <code className="font-mono text-xs">checkout.session.completed</code>,{' '}
            <code className="font-mono text-xs">invoice.paid</code> and{' '}
            <code className="font-mono text-xs">invoice.payment_failed</code>, and turn the customer
            portal on.
          </p>
        </div>
        <Switch checked={form.stripeEnabled} onChange={(on) => set({ stripeEnabled: on })}>
          Take card payments
        </Switch>
        {fieldErrors('stripeEnabled')}
        <Field
          id="stripe-publishable"
          label="Publishable key"
          errors={errorsFor(errors, 'stripePublishableKey')}
        >
          {(control) => (
            <Input
              {...control}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              value={form.stripePublishableKey}
              onChange={(event) => set({ stripePublishableKey: event.target.value })}
            />
          )}
        </Field>
        <SecretField
          id="stripe-secret"
          label="Secret key"
          noun="secret key"
          saved={settings.hasStripeSecretKey}
          value={form.stripeSecretKey}
          errors={errorsFor(errors, 'stripeSecretKey')}
          onChange={(value) => set({ stripeSecretKey: value })}
        />
        <SecretField
          id="stripe-webhook-secret"
          label="Webhook signing secret"
          noun="webhook signing secret"
          saved={settings.hasStripeWebhookSecret}
          value={form.stripeWebhookSecret}
          errors={errorsFor(errors, 'stripeWebhookSecret')}
          onChange={(value) => set({ stripeWebhookSecret: value })}
        />
        <CopyField
          id="stripe-webhook-url"
          label="Webhook endpoint"
          value={settings.stripeWebhookUrl}
        />
        <ConnectionCheck provider="stripe" disabled={!settings.hasStripeSecretKey} />
      </section>

      <section className="grid gap-4 rounded-box border p-5" aria-labelledby="crypto-heading">
        <div>
          <h2 id="crypto-heading" className="font-semibold text-lg">
            Crypto payments (NOWPayments)
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            Crypto buys months up front. In the NOWPayments dashboard copy the API key and make an
            IPN secret. Each invoice names the address below for its payment notices.
          </p>
        </div>
        <Switch
          checked={form.nowPaymentsEnabled}
          onChange={(on) => set({ nowPaymentsEnabled: on })}
        >
          Take crypto payments
        </Switch>
        {fieldErrors('nowPaymentsEnabled')}
        <SecretField
          id="nowpayments-key"
          label="API key"
          noun="API key"
          saved={settings.hasNowPaymentsApiKey}
          value={form.nowPaymentsApiKey}
          errors={errorsFor(errors, 'nowPaymentsApiKey')}
          onChange={(value) => set({ nowPaymentsApiKey: value })}
        />
        <SecretField
          id="nowpayments-ipn"
          label="IPN secret"
          noun="IPN secret"
          saved={settings.hasNowPaymentsIpnSecret}
          value={form.nowPaymentsIpnSecret}
          errors={errorsFor(errors, 'nowPaymentsIpnSecret')}
          onChange={(value) => set({ nowPaymentsIpnSecret: value })}
        />
        <Switch
          checked={form.nowPaymentsSandbox}
          onChange={(on) => set({ nowPaymentsSandbox: on })}
        >
          Use the NOWPayments sandbox
        </Switch>
        <fieldset className="grid gap-2">
          <legend className="mb-1 font-medium text-sm">Periods to sell</legend>
          <div className="flex flex-wrap gap-4">
            {PERIODS.map((months) => (
              <Switch
                key={months}
                checked={form.cryptoMonths.includes(months)}
                onChange={(on) =>
                  set({
                    cryptoMonths: on
                      ? [...form.cryptoMonths, months]
                      : form.cryptoMonths.filter((m) => m !== months),
                  })
                }
              >
                {months} {months === 1 ? 'month' : 'months'}
              </Switch>
            ))}
          </div>
          {fieldErrors('cryptoMonths')}
        </fieldset>
        <CopyField
          id="nowpayments-ipn-url"
          label="IPN address"
          value={settings.nowPaymentsIpnUrl}
        />
        <ConnectionCheck provider="nowpayments" disabled={!settings.hasNowPaymentsApiKey} />
      </section>

      <div className="flex items-center gap-3">
        <Button ref={saveButton} type="submit">
          Save
        </Button>
        {message && (
          <p role="status" className="font-medium text-sm text-success">
            {message}
          </p>
        )}
      </div>
      <ConflictDialog
        open={conflict !== null}
        returnFocus={saveButton}
        onCancel={() => setConflict(null)}
        onLoadTheirs={() => {
          setConflict(null);
          void load();
        }}
        onOverwrite={() => {
          const version = conflict;
          setConflict(null);
          if (version) void save(version);
        }}
      />
    </form>
  );
}
