import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest, type Problem } from '@/lib/admin/api';
import { errorsFor, type FieldErrors, unplacedErrors } from '@/lib/admin/problems';
import type { Role, UserInvited } from '@/lib/admin/users';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { RoleField } from './RoleField';
import { SetupLinkPanel } from './SetupLinkPanel';

const FIELDS = ['email', 'displayName', 'roles'];

/** Makes a staff account and hands the Admin its one-time link to set a password. */
export default function InviteForm() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('Editor');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [invited, setInvited] = useState<UserInvited | null>(null);
  const busy = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  useEffect(() => {
    if (invited) done.current?.focus();
  }, [invited]);

  const submit = async () => {
    if (busy.current) return;
    busy.current = true;
    const response = await apiRequest<UserInvited>('/users', {
      method: 'POST',
      body: { email: email.trim(), displayName: displayName.trim(), roles: [role] },
    });
    busy.current = false;
    if (!response.ok) {
      setProblem(response.problem);
      setErrors(response.problem.errors);
      return;
    }
    setProblem(null);
    setErrors({});
    setInvited(response.value);
  };

  if (invited) {
    return (
      <div className="grid max-w-2xl gap-6">
        <h1
          ref={done}
          tabIndex={-1}
          className="font-display font-extrabold text-3xl tracking-tight outline-none"
        >
          {invited.user.displayName} is invited
        </h1>
        <SetupLinkPanel id="invite-link" label="Invitation link" link={invited.setupLink} />
        <div className="flex flex-wrap gap-4 text-sm">
          <a
            className="font-medium underline-offset-4 hover:underline"
            href={`/admin/users/${invited.user.id}`}
          >
            Open {invited.user.displayName}
          </a>
          <a className="font-medium underline-offset-4 hover:underline" href="/admin/users/new">
            Invite someone else
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="grid max-w-2xl gap-6">
      <div className="grid gap-2">
        <a href="/admin/users" className="text-muted-foreground text-sm hover:underline">
          All users
        </a>
        <h1 className="font-display font-extrabold text-3xl tracking-tight">Invite a user</h1>
      </div>
      <ErrorSummary
        problem={problem}
        unplaced={unplacedErrors(errors, FIELDS)}
        summaryRef={summary}
      />
      <form
        noValidate
        className="grid gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field id="invite-email" label="Email" errors={errorsFor(errors, 'email')}>
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field id="invite-name" label="Name" errors={errorsFor(errors, 'displayName')}>
          {(control) => (
            <Input
              {...control}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>
        <RoleField
          id="invite-role"
          value={role}
          onChange={setRole}
          errors={errorsFor(errors, 'roles')}
        />
        <div className="border-t pt-6">
          <Button type="submit">Create invitation</Button>
        </div>
      </form>
    </div>
  );
}
