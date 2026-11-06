import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { apiRequest, type Problem } from '@/lib/admin/api';
import { errorsFor } from '@/lib/admin/problems';
import { type AccountType, PROVIDER_LABELS, planEnds, type Subscription } from '@/lib/billing';
import { ConfirmButton } from './ConfirmButton';
import { Field } from './Field';

interface UserPlan {
  accountType: AccountType;
  subscription: Subscription | null;
}

/**
 * A user's plan on their admin page (E53): what they have, and a way to give them a type (with an
 * end date, or none) or take a given one away. A card subscription is Stripe's to change.
 */
export function UserPlanPanel({ userId }: { userId: number }) {
  const path = `/users/${userId}/subscriptions/current`;
  const [plan, setPlan] = useState<UserPlan | null>(null);
  const [types, setTypes] = useState<AccountType[]>([]);
  const [typeId, setTypeId] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [current, all] = await Promise.all([
      apiRequest<UserPlan>(path),
      apiRequest<AccountType[]>('/account-types?includeInactive=true'),
    ]);
    if (current.ok) setPlan(current.value);
    if (all.ok) {
      const paid = all.value.filter((t) => !t.isFree);
      setTypes(paid);
      setTypeId((id) => id || String(paid[0]?.id ?? ''));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const grant = async () => {
    setMessage(null);
    const response = await apiRequest<UserPlan>(path, {
      method: 'PUT',
      body: {
        accountTypeId: Number(typeId),
        endsAt: endsOn ? new Date(`${endsOn}T23:59:59Z`).toISOString() : null,
      },
    });
    if (!response.ok) {
      setProblem(response.problem);
      return;
    }
    setProblem(null);
    setPlan(response.value);
    setMessage(`They are on ${response.value.accountType.name} now.`);
  };

  const remove = async () => {
    const response = await apiRequest(path, { method: 'DELETE' });
    if (!response.ok) {
      setProblem(response.problem);
      return;
    }
    setProblem(null);
    setMessage('They are on Free now.');
    await load();
  };

  const subscription = plan?.subscription ?? null;
  const ends = planEnds(subscription);
  const card = subscription?.provider === 'stripe';

  return (
    <section className="grid gap-4 rounded-box border p-5" aria-labelledby="plan-heading">
      <div>
        <h2 id="plan-heading" className="font-semibold text-lg">
          Plan
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {plan
            ? `${plan.accountType.name}${subscription ? ` · ${PROVIDER_LABELS[subscription.provider]}${ends ? ` · ${ends.label}` : ''}` : ''}`
            : 'Loading…'}
        </p>
      </div>
      {card ? (
        <p className="text-sm">
          They pay by card. Change or cancel their plan in the Stripe dashboard; this page follows.
        </p>
      ) : (
        <form
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void grant();
          }}
        >
          <Field
            id={`plan-type-${userId}`}
            label="Give them"
            errors={errorsFor(problem?.errors ?? {}, 'accountTypeId')}
          >
            {(control) => (
              <NativeSelect
                {...control}
                value={typeId}
                onChange={(event) => setTypeId(event.target.value)}
              >
                {types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                    {!type.isActive && ' (archived)'}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            id={`plan-ends-${userId}`}
            label="Until"
            hint="Empty for no end."
            errors={errorsFor(problem?.errors ?? {}, 'endsAt')}
          >
            {(control) => (
              <Input
                {...control}
                type="date"
                value={endsOn}
                onChange={(event) => setEndsOn(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="outline" disabled={!typeId}>
            Give plan
          </Button>
        </form>
      )}
      {subscription && !card && (
        <div>
          <ConfirmButton
            label="Take the plan away"
            title="Put this account back on Free?"
            description="Their online monitors over the Free limit are paused at once. Their history stays."
            confirmLabel="Put on Free"
            onConfirm={() => void remove()}
          />
        </div>
      )}
      {problem && problem.status !== 400 && (
        <p className="font-medium text-destructive text-sm">{problem.detail || problem.title}</p>
      )}
      {message && (
        <p role="status" className="font-medium text-sm text-success">
          {message}
        </p>
      )}
    </section>
  );
}
