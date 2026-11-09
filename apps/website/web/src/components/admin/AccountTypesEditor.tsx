import { Pencil, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiRequest, type Problem } from '@/lib/admin/api';
import {
  type AccountTypeForm,
  accountTypeBody,
  emptyAccountTypeForm,
  fromAccountType,
} from '@/lib/admin/billing';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import { type AccountType, intervalLabel, monitorsLabel, price } from '@/lib/billing';
import { cn } from '@/lib/utils';
import { ConflictDialog } from './ConflictDialog';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { Switch } from './SecretField';

const PATH = '/account-types';

interface Editing {
  /** null while making a new type. */
  type: AccountType | null;
  form: AccountTypeForm;
}

/** One type's form: what it allows, what it costs, and whether it is offered. */
function TypeForm({
  editing,
  errors,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  editing: Editing;
  errors: FieldErrors;
  saving: boolean;
  onChange: (patch: Partial<AccountTypeForm>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { form, type } = editing;
  const isFree = type?.isFree ?? false;
  const prefix = type ? `type-${type.id}` : 'type-new';
  const text = (name: keyof AccountTypeForm, label: string, hint?: string, extra?: object) => (
    <Field id={`${prefix}-${name}`} label={label} hint={hint} errors={errorsFor(errors, name)}>
      {(control) => (
        <Input
          {...control}
          {...extra}
          value={form[name] as string}
          onChange={(event) => onChange({ [name]: event.target.value })}
        />
      )}
    </Field>
  );
  return (
    <form
      noValidate
      className="grid gap-5 rounded-box border bg-muted/20 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {type ? (
          <div className="grid content-start gap-2">
            <span className="font-medium text-sm">Key</span>
            <code className="font-mono text-sm">{type.key}</code>
          </div>
        ) : (
          text('key', 'Key', 'Lower-case letters, digits and dashes. It never changes.', {
            className: 'font-mono',
            autoComplete: 'off',
            spellCheck: false,
          })
        )}
        {text('name', 'Name')}
      </div>
      <Field
        id={`${prefix}-description`}
        label="Description"
        errors={errorsFor(errors, 'description')}
      >
        {(control) => (
          <Input
            {...control}
            value={form.description}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${prefix}-features`}
        label="Features"
        hint="One per line, as the plan cards list them."
        errors={errorsFor(errors, 'features')}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            value={form.features}
            onChange={(event) => onChange({ features: event.target.value })}
          />
        )}
      </Field>
      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 font-semibold text-sm">Limits</legend>
        {text('maxCloudMonitors', 'Online monitors', 'Empty for unlimited.', {
          inputMode: 'numeric',
        })}
        {text('minIntervalSec', 'Shortest interval (seconds)', 'At least 30.', {
          inputMode: 'numeric',
        })}
        {text('historyDays', 'Detailed history (days)', undefined, { inputMode: 'numeric' })}
      </fieldset>
      {!isFree && (
        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="mb-2 font-semibold text-sm">Price</legend>
          {text('monthlyPrice', 'Monthly', 'Empty to not sell monthly.', { inputMode: 'decimal' })}
          {text('yearlyPrice', 'Yearly', 'Empty for 12 times monthly.', { inputMode: 'decimal' })}
          {text('currency', 'Currency', 'Such as usd or eur.', { className: 'font-mono' })}
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        {text('sortOrder', 'Order', 'Lower comes first.', { inputMode: 'numeric' })}
        <div className="grid content-end gap-3 sm:col-span-2">
          {!isFree && (
            <Switch checked={form.isActive} onChange={(on) => onChange({ isActive: on })}>
              Offered (an archived type stays with the accounts that have it)
            </Switch>
          )}
          <Switch checked={form.highlight} onChange={(on) => onChange({ highlight: on })}>
            Show as the one to pick
          </Switch>
          <Switch checked={form.encryptedItems} onChange={(on) => onChange({ encryptedItems: on })}>
            Encrypted notifications and sync
          </Switch>
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : type ? 'Save type' : 'Make type'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The account types (E53): what each allows and costs, for Admins to make and change. */
export default function AccountTypesEditor() {
  const [types, setTypes] = useState<AccountType[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const summary = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const response = await apiRequest<AccountType[]>(`${PATH}?includeInactive=true`);
    if (response.ok) setTypes(response.value);
    else setProblem(response.problem);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  const edit = (type: AccountType | null) => {
    setErrors({});
    setProblem(null);
    setMessage(null);
    setEditing({ type, form: type ? fromAccountType(type) : emptyAccountTypeForm() });
  };

  const save = async (overwrite?: string) => {
    if (!editing) return;
    setSaving(true);
    const { type, form } = editing;
    const response = type
      ? await apiRequest<AccountType>(`${PATH}/${type.id}`, {
          method: 'PATCH',
          body: accountTypeBody(form, false, type.isFree),
          ifMatch: `"${overwrite ?? type.version}"`,
        })
      : await apiRequest<AccountType>(PATH, {
          method: 'POST',
          body: accountTypeBody(form, true, false),
        });
    setSaving(false);
    if (response.ok) {
      setEditing(null);
      setErrors({});
      setProblem(null);
      setMessage(`${response.value.name} is saved.`);
      await load();
      return;
    }
    if (response.problem.status === 412) {
      setConflict(true);
      return;
    }
    setErrors(response.problem.errors);
    setProblem(response.problem);
  };

  if (!types) {
    return problem ? (
      <ErrorSummary problem={problem} summaryRef={summary} />
    ) : (
      <p className="text-muted-foreground text-sm">Loading the account types…</p>
    );
  }

  return (
    <div className="grid gap-6">
      <ErrorSummary problem={problem} summaryRef={summary} />
      {message && (
        <p role="status" className="font-medium text-sm text-success">
          {message}
        </p>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {types.map((type) => (
          <li
            key={type.id}
            className={cn(
              'grid content-start gap-3 rounded-box border p-5',
              !type.isActive && 'opacity-70',
              type.highlight && 'border-primary/50',
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold text-lg">
                  {type.name}{' '}
                  <code className="font-mono text-muted-foreground text-xs">{type.key}</code>
                </h2>
                <p className="text-muted-foreground text-sm">
                  {type.isFree
                    ? 'Free, for every account without a paid type'
                    : [
                        type.monthlyPriceCents !== null &&
                          `${price(type.monthlyPriceCents, type.currency)} a month`,
                        type.yearlyPriceCents !== null &&
                          `${price(type.yearlyPriceCents, type.currency)} a year`,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No price'}
                  {!type.isActive && ' · Archived'}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Edit ${type.name}`}
                onClick={() => edit(type)}
              >
                <Pencil aria-hidden />
                Edit
              </Button>
            </div>
            <p className="text-sm">
              {monitorsLabel(type.maxCloudMonitors)}, checked {intervalLabel(type.minIntervalSec)},{' '}
              {type.historyDays} days of detailed history.
            </p>
            {editing?.type?.id === type.id && (
              <TypeForm
                editing={editing}
                errors={errors}
                saving={saving}
                onChange={(patch) =>
                  setEditing({ ...editing, form: { ...editing.form, ...patch } })
                }
                onSave={() => void save()}
                onCancel={() => setEditing(null)}
              />
            )}
          </li>
        ))}
      </ul>
      {editing && editing.type === null ? (
        <TypeForm
          editing={editing}
          errors={errors}
          saving={saving}
          onChange={(patch) => setEditing({ ...editing, form: { ...editing.form, ...patch } })}
          onSave={() => void save()}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div>
          <Button ref={newButton} type="button" variant="outline" onClick={() => edit(null)}>
            <Plus aria-hidden />
            New account type
          </Button>
        </div>
      )}
      <ConflictDialog
        open={conflict}
        returnFocus={newButton}
        onCancel={() => setConflict(false)}
        onLoadTheirs={() => {
          setConflict(false);
          setEditing(null);
          void load();
        }}
        onOverwrite={() => {
          setConflict(false);
          void (async () => {
            const current = await apiRequest<AccountType>(`${PATH}/${editing?.type?.id}`);
            if (current.ok) await save(current.value.version);
          })();
        }}
      />
    </div>
  );
}
