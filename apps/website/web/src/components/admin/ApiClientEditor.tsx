import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { apiRequest, type Problem } from '@/lib/admin/api';
import {
  type ApiClient,
  type ApiClientCreated,
  type ApiClientSecret,
  DEFAULT_OVERLAP,
  OVERLAPS,
  SCOPES,
} from '@/lib/admin/apiClients';
import { errorsFor, errorsUnder, type FieldErrors, unplacedErrors } from '@/lib/admin/problems';
import { splitList, toLocalInput } from '@/lib/admin/publishing';
import { ConfirmButton } from './ConfirmButton';
import { ErrorSummary } from './ErrorSummary';
import { Field, FieldErrors as Messages } from './Field';
import { SecretDialog } from './SecretDialog';
import { formatTime } from './useAdminList';

interface Form {
  name: string;
  scopes: string[];
  /** One address or range per line, as typed. */
  ipAllowlist: string;
  /** A `datetime-local` value, or empty for no expiry. */
  expiresAt: string;
}

const EMPTY: Form = { name: '', scopes: [], ipAllowlist: '', expiresAt: '' };
const FIELDS = ['name', 'scopes', 'ipAllowlist', 'expiresAt'];

const fromClient = (client: ApiClient): Form => ({
  name: client.name,
  scopes: client.scopes,
  ipAllowlist: client.ipAllowlist.join('\n'),
  expiresAt: toLocalInput(client.expiresAt),
});

function writeBody(form: Form) {
  const expires = form.expiresAt ? new Date(form.expiresAt) : null;
  return {
    name: form.name.trim(),
    scopes: form.scopes,
    ipAllowlist: splitList(form.ipAllowlist),
    expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires.toISOString() : null,
  };
}

const ifMatch = (client: ApiClient) => `"${client.version}"`;

interface ApiClientEditorProps {
  /** The client to show, or none to make a new one. */
  id?: number;
  /** Where the browser goes once a new client's secret is saved; tests replace it. */
  navigate?: (path: string) => void;
}

const goTo = (path: string) => window.location.assign(path);

/**
 * A new API client, or an existing one with its keys. The secret appears once, in a dialog,
 * right after a create or a rotation, and the page keeps it only while that dialog is open.
 */
export default function ApiClientEditor({ id, navigate = goTo }: ApiClientEditorProps) {
  const [client, setClient] = useState<ApiClient | null>(null);
  const [loading, setLoading] = useState(id !== undefined);
  const [form, setForm] = useState<Form>(EMPTY);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [secret, setSecret] = useState<{
    keyId: string;
    secret: string;
    whenSaved: () => void;
  } | null>(null);
  const [overlap, setOverlap] = useState(DEFAULT_OVERLAP);
  const busy = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const revokedNote = useRef<HTMLParagraphElement>(null);
  const rotateButton = useRef<HTMLButtonElement>(null);
  const revokedJustNow = useRef(false);

  const fail = useCallback((next: Problem) => {
    setProblem(next);
    setErrors(next.errors);
    setMessage(null);
  }, []);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  const load = useCallback(async () => {
    if (id === undefined) return null;
    const response = await apiRequest<ApiClient>(`/api-clients/${id}`);
    setLoading(false);
    if (!response.ok) {
      fail(response.problem);
      return null;
    }
    setClient(response.value);
    setForm(fromClient(response.value));
    return response.value;
  }, [id, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  // The Revoke button goes away with the revocation, so focus moves to the note that replaces
  // it, once that has rendered.
  useEffect(() => {
    if (!revokedJustNow.current || !client?.revokedAt) return;
    revokedJustNow.current = false;
    revokedNote.current?.focus();
  }, [client]);

  /** Runs one call at a time, so a double click does not make two clients or two keys. */
  const once = async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await action();
    } finally {
      busy.current = false;
    }
  };

  const save = () =>
    once(async () => {
      if (!client) {
        const response = await apiRequest<ApiClientCreated>('/api-clients', {
          method: 'POST',
          body: writeBody(form),
        });
        if (!response.ok) return fail(response.problem);
        const created = response.value;
        setProblem(null);
        setErrors({});
        setSecret({
          keyId: created.keyId,
          secret: created.secret,
          whenSaved: () => navigate(`/admin/api-clients/${created.client.id}`),
        });
        return;
      }
      const response = await apiRequest<ApiClient>(`/api-clients/${client.id}`, {
        method: 'PATCH',
        body: writeBody(form),
        ifMatch: ifMatch(client),
      });
      if (!response.ok) return fail(response.problem);
      setClient(response.value);
      setForm(fromClient(response.value));
      setProblem(null);
      setErrors({});
      setMessage('Saved.');
    });

  const rotate = () =>
    once(async () => {
      if (!client) return;
      const response = await apiRequest<ApiClientSecret>(`/api-clients/${client.id}/secrets`, {
        method: 'POST',
        body: { overlapMinutes: overlap },
      });
      if (!response.ok) return fail(response.problem);
      setProblem(null);
      setSecret({
        keyId: response.value.keyId,
        secret: response.value.secret,
        whenSaved: () => void load(),
      });
    });

  const revoke = () =>
    once(async () => {
      if (!client) return;
      const response = await apiRequest(`/api-clients/${client.id}`, {
        method: 'DELETE',
        ifMatch: ifMatch(client),
      });
      if (!response.ok) return fail(response.problem);
      setProblem(null);
      setMessage(null);
      revokedJustNow.current = true;
      await load();
    });

  const toggleScope = (scope: string, on: boolean) =>
    setForm((current) => ({
      ...current,
      scopes: on
        ? SCOPES.map((each) => each.value).filter(
            (each) => each === scope || current.scopes.includes(each),
          )
        : current.scopes.filter((each) => each !== scope),
    }));

  const revoked = client?.revokedAt != null;
  const scopeErrors = errorsUnder(errors, 'scopes');

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <a href="/admin/api-clients" className="text-muted-foreground text-sm hover:underline">
          All API clients
        </a>
        <h1 className="font-display font-extrabold text-3xl tracking-tight">
          {id === undefined ? 'New API client' : (client?.name ?? 'API client')}
        </h1>
      </div>
      <ErrorSummary
        problem={problem}
        unplaced={unplacedErrors(errors, FIELDS)}
        summaryRef={summary}
      />
      {loading && <p className="text-muted-foreground">Loading.</p>}
      {client?.revokedAt && (
        <p
          ref={revokedNote}
          tabIndex={-1}
          className="rounded-md border p-4 text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
        >
          This client was revoked on {formatTime(client.revokedAt)}. Its keys no longer sign
          anything, and it can not be used again.
        </p>
      )}
      {!loading && (id === undefined || client) && (
        <form
          noValidate
          className="grid max-w-2xl gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={revoked} className="grid gap-6">
            <Field id="api-client-name" label="Name" errors={errorsFor(errors, 'name')}>
              {(control) => (
                <Input
                  {...control}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              )}
            </Field>
            <fieldset
              className="grid gap-2"
              aria-describedby={scopeErrors.length > 0 ? 'api-client-scopes-errors' : undefined}
            >
              <legend className="mb-2 font-medium text-sm">Scopes</legend>
              {SCOPES.map((scope) => (
                <label key={scope.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={form.scopes.includes(scope.value)}
                    onChange={(event) => toggleScope(scope.value, event.target.checked)}
                  />
                  {scope.label}{' '}
                  <span className="font-mono text-muted-foreground">{scope.value}</span>
                </label>
              ))}
              <Messages id="api-client-scopes-errors" errors={scopeErrors} />
            </fieldset>
            <Field
              id="api-client-ips"
              label="Allowed IP addresses"
              hint="One IPv4 or IPv6 address or CIDR range per line. Leave it empty to allow any address."
              errors={errorsUnder(errors, 'ipAllowlist')}
            >
              {(control) => (
                <Textarea
                  {...control}
                  rows={3}
                  className="font-mono"
                  value={form.ipAllowlist}
                  onChange={(event) => setForm({ ...form, ipAllowlist: event.target.value })}
                />
              )}
            </Field>
            <Field
              id="api-client-expires"
              label="Expires"
              hint="In your own time zone. Leave it empty for a client that does not expire."
              errors={errorsFor(errors, 'expiresAt')}
              className="max-w-xs"
            >
              {(control) => (
                <Input
                  {...control}
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
                />
              )}
            </Field>
          </fieldset>
          {!revoked && (
            <div className="flex flex-wrap items-center gap-4 border-t pt-6">
              <Button type="submit">{client ? 'Save' : 'Create client'}</Button>
              {message && (
                <p role="status" className="text-sm">
                  {message}
                </p>
              )}
            </div>
          )}
        </form>
      )}
      {client && (
        <section className="grid max-w-2xl gap-4" aria-labelledby="api-client-keys">
          <h2 id="api-client-keys" className="font-display font-bold text-xl">
            Keys
          </h2>
          <table className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Key id
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Made
                </th>
                <th scope="col" className="py-2 font-medium">
                  Works until
                </th>
              </tr>
            </thead>
            <tbody>
              {client.keys.map((key) => (
                <tr key={key.keyId} className="border-b">
                  <td className="py-3 pe-4 font-mono">{key.keyId}</td>
                  <td className="py-3 pe-4">{formatTime(key.createdAt)}</td>
                  <td className="py-3">
                    {key.expiresAt ? formatTime(key.expiresAt) : 'Current key'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted-foreground text-sm">
            Last used {formatTime(client.lastUsedAt, 'never')}.
          </p>
          {!revoked && (
            <div className="flex flex-wrap gap-4">
              <ConfirmButton
                label="Rotate secret"
                triggerRef={rotateButton}
                title="Rotate the secret?"
                description="A new key and secret replace the current ones. Give the new secret to the other system before the old key stops working."
                confirmLabel="Rotate"
                onConfirm={() => void rotate()}
              >
                <Field id="api-client-overlap" label="The old key keeps working">
                  {(control) => (
                    <NativeSelect
                      {...control}
                      value={overlap}
                      onChange={(event) => setOverlap(Number(event.target.value))}
                    >
                      {OVERLAPS.map((each) => (
                        <option key={each.minutes} value={each.minutes}>
                          {each.label}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              </ConfirmButton>
              <ConfirmButton
                label="Revoke client"
                title={`Revoke ${client.name}?`}
                description="Every request it signs is refused from now on. This can not be undone; the client stays listed for the audit trail."
                confirmLabel="Revoke"
                onConfirm={() => void revoke()}
              />
            </div>
          )}
        </section>
      )}
      <SecretDialog
        // After a rotation focus goes back to the Rotate button; a new client opens its page.
        returnFocusTo={rotateButton}
        open={secret !== null}
        keyId={secret?.keyId ?? ''}
        secret={secret?.secret ?? ''}
        onDone={() => {
          const whenSaved = secret?.whenSaved;
          setSecret(null);
          whenSaved?.();
        }}
      />
    </div>
  );
}
