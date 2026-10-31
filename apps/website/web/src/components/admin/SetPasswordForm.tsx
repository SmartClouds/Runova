import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest, type Problem } from '@/lib/admin/api';
import { SIGN_IN_PATH } from '@/lib/admin/guard';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import { setupToken } from '@/lib/admin/users';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';

const USED_UP = 'This link was already used or has expired. Ask an Admin for a new one.';

/** Reads the token once and takes it out of the address, so it is not left in the history. */
function takeToken(): string | null {
  const token = setupToken(window.location.hash);
  if (window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  return token;
}

/** Sets a password from an invitation or a password reset link. */
export default function SetPasswordForm() {
  const [token] = useState(takeToken);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState(false);
  const busy = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const doneNote = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  useEffect(() => {
    if (done) doneNote.current?.focus();
  }, [done]);

  if (!token) {
    return (
      <p>
        Open the link you were sent to set your password. If it does not work, ask an Admin for a
        new one.
      </p>
    );
  }

  if (done) {
    return (
      <div className="grid gap-4">
        <p ref={doneNote} tabIndex={-1} className="font-medium outline-none">
          Your password is set.
        </p>
        <p>
          <a className="font-medium text-primary underline underline-offset-4" href={SIGN_IN_PATH}>
            Sign in
          </a>{' '}
          with your email and the new password.
        </p>
      </div>
    );
  }

  const submit = async () => {
    if (password !== repeat) {
      setProblem(null);
      setErrors({ repeat: ['The two passwords are not the same.'] });
      document.getElementById('set-password-repeat')?.focus();
      return;
    }
    if (busy.current) return;
    busy.current = true;
    const response = await apiRequest('/password-setups', {
      method: 'POST',
      body: { token, password },
    });
    busy.current = false;
    if (response.ok) {
      setDone(true);
      return;
    }
    const failure = response.problem;
    setErrors(failure.errors);
    setProblem(failure.status === 404 ? { ...failure, detail: USED_UP } : failure);
  };

  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ErrorSummary problem={problem} summaryRef={summary} offerSignIn={false} />
      <Field
        id="set-password-new"
        label="New password"
        hint="At least 12 characters. A few words in a row make a good one."
        errors={errorsFor(errors, 'password')}
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <Field
        id="set-password-repeat"
        label="Repeat the password"
        errors={errorsFor(errors, 'repeat')}
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit">Set password</Button>
      </div>
    </form>
  );
}
