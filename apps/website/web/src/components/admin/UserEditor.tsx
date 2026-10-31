import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest, type Problem } from '@/lib/admin/api';
import { errorsFor, type FieldErrors, unplacedErrors } from '@/lib/admin/problems';
import {
  type Role,
  roleOf,
  type SetupLink,
  STATUS_LABELS,
  type StaffUser,
  userStatus,
} from '@/lib/admin/users';
import { ConfirmButton } from './ConfirmButton';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { RoleField } from './RoleField';
import { SetupLinkPanel } from './SetupLinkPanel';
import { formatTime } from './useAdminList';

const FIELDS = ['displayName', 'roles'];

type LinkKind = 'Invitation link' | 'Password reset link';

const ifMatch = (user: StaffUser) => `"${user.version}"`;

/** One staff account: its name and role, and the Admin actions on it. */
export default function UserEditor({ id }: { id: number }) {
  const [user, setUser] = useState<StaffUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('Editor');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<{ kind: LinkKind; link: SetupLink } | null>(null);
  const busy = useRef(false);
  const summary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  const show = useCallback((next: StaffUser) => {
    setUser(next);
    setDisplayName(next.displayName);
    setRole(roleOf(next));
  }, []);

  const fail = (next: Problem) => {
    setProblem(next);
    setErrors(next.errors);
    setMessage(null);
  };

  const load = useCallback(async () => {
    const response = await apiRequest<StaffUser>(`/users/${id}`);
    setLoading(false);
    if (response.ok) show(response.value);
    else setProblem(response.problem);
  }, [id, show]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One call at a time, against the version on screen; a success shows the account as it is now. */
  const once = async (action: (current: StaffUser) => Promise<void>) => {
    if (busy.current || !user) return;
    busy.current = true;
    try {
      await action(user);
    } finally {
      busy.current = false;
    }
  };

  const patch = (body: Record<string, unknown>, done: string) =>
    once(async (current) => {
      const response = await apiRequest<StaffUser>(`/users/${current.id}`, {
        method: 'PATCH',
        body,
        ifMatch: ifMatch(current),
      });
      if (!response.ok) return fail(response.problem);
      show(response.value);
      setProblem(null);
      setErrors({});
      setMessage(done);
    });

  const resetTwoFactor = () =>
    once(async (current) => {
      const response = await apiRequest(`/users/${current.id}/two-factor`, { method: 'DELETE' });
      if (!response.ok) return fail(response.problem);
      setProblem(null);
      setMessage(null);
      await load();
    });

  const makeLink = (kind: LinkKind) =>
    once(async (current) => {
      const path = kind === 'Invitation link' ? 'invitations' : 'password-resets';
      const response = await apiRequest<SetupLink>(`/users/${current.id}/${path}`, {
        method: 'POST',
      });
      if (!response.ok) return fail(response.problem);
      setProblem(null);
      setLink({ kind, link: response.value });
    });

  const status = user ? userStatus(user) : null;

  return (
    <div className="grid max-w-2xl gap-6">
      <div className="grid gap-2">
        <a href="/admin/users" className="text-muted-foreground text-sm hover:underline">
          All users
        </a>
        <h1 className="font-display font-extrabold text-3xl tracking-tight">
          {user?.displayName ?? 'User'}
        </h1>
        {user && <p className="text-muted-foreground">{user.email}</p>}
      </div>
      <ErrorSummary
        problem={problem}
        unplaced={unplacedErrors(errors, FIELDS)}
        summaryRef={summary}
      />
      {loading && <p className="text-muted-foreground">Loading.</p>}
      {user && status && (
        <>
          <form
            noValidate
            className="grid gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              void patch({ displayName: displayName.trim(), roles: [role] }, 'Saved.');
            }}
          >
            <Field id="user-name" label="Name" errors={errorsFor(errors, 'displayName')}>
              {(control) => (
                <Input
                  {...control}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              )}
            </Field>
            <RoleField
              id="user-role"
              value={role}
              onChange={setRole}
              errors={errorsFor(errors, 'roles')}
            />
            <div className="flex flex-wrap items-center gap-4 border-t pt-6">
              <Button type="submit">Save</Button>
              {message && (
                <p role="status" className="text-sm">
                  {message}
                </p>
              )}
            </div>
          </form>
          <section className="grid gap-4 border-t pt-6" aria-labelledby="user-account">
            <h2 id="user-account" className="font-display font-bold text-xl">
              Account
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="font-medium">Status</dt>
              <dd>{STATUS_LABELS[status]}</dd>
              <dt className="font-medium">Last sign-in</dt>
              <dd>{formatTime(user.lastSignInAt)}</dd>
              <dt className="font-medium">Two-factor</dt>
              <dd>
                {user.twoFactorEnabled ? 'Two-factor sign-in is on.' : 'Two-factor sign-in is off.'}
              </dd>
            </dl>
            <div className="flex flex-wrap gap-4">
              {user.disabled ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void patch({ disabled: false }, 'The account is enabled.')}
                >
                  Enable account
                </Button>
              ) : (
                <ConfirmButton
                  label="Disable account"
                  title={`Disable ${user.displayName}?`}
                  description="They are signed out everywhere at once and can not sign in until an Admin enables the account again."
                  confirmLabel="Disable"
                  onConfirm={() => void patch({ disabled: true }, 'The account is disabled.')}
                />
              )}
              {user.twoFactorEnabled && (
                <ConfirmButton
                  label="Reset two-factor"
                  title={`Reset two-factor for ${user.displayName}?`}
                  description="Their authenticator and recovery codes stop working. They sign in with the password alone until they turn two-factor on again."
                  confirmLabel="Reset"
                  onConfirm={() => void resetTwoFactor()}
                />
              )}
              {status === 'invited' ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void makeLink('Invitation link')}
                >
                  New invitation link
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void makeLink('Password reset link')}
                >
                  Password reset link
                </Button>
              )}
            </div>
            {link && <SetupLinkPanel id="user-link" label={link.kind} link={link.link} />}
          </section>
        </>
      )}
    </div>
  );
}
