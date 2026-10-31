import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest, type Problem, safeNextPath } from '@/lib/admin/api';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';

type Step = 'password' | 'code';
type CodeKind = 'totp' | 'recovery';

const CODE_INPUT = { totp: 'sign-in-code', recovery: 'sign-in-recovery' } as const;

interface SignInFormProps {
  /** Where the browser goes once signed in; tests replace it. */
  navigate?: (path: string) => void;
}

const goTo = (path: string) => window.location.assign(path);

/** The lock message with how long is left, rounded up to whole minutes. */
function lockedProblem(problem: Problem): Problem {
  if (!problem.retryAfter) return problem;
  const minutes = Math.max(1, Math.ceil(problem.retryAfter / 60));
  const wait = `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  return { ...problem, detail: `${problem.detail || problem.title} ${wait}` };
}

/** Email and password first, then the authenticator or recovery code when the account has one. */
export default function SignInForm({ navigate = goTo }: SignInFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<Step>('password');
  const [codeKind, setCodeKind] = useState<CodeKind>('totp');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const submitting = useRef(false);
  const summary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  useEffect(() => {
    if (!focusNext) return;
    document.getElementById(focusNext)?.focus();
    setFocusNext(null);
  }, [focusNext]);

  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    const response = await apiRequest('/sessions', {
      method: 'POST',
      body: {
        email,
        password,
        twoFactorCode: step === 'code' && codeKind === 'totp' ? code.replace(/\s/g, '') : null,
        recoveryCode: step === 'code' && codeKind === 'recovery' ? code.trim() : null,
      },
    });
    submitting.current = false;

    if (response.ok) {
      navigate(safeNextPath(new URLSearchParams(window.location.search).get('next')));
      return;
    }
    const failure = response.problem;
    if (failure.type === 'two-factor-required') {
      setProblem(null);
      if (step === 'password') {
        setErrors({});
        setStep('code');
        setFocusNext(CODE_INPUT[codeKind]);
      } else {
        setErrors({ code: [failure.detail || failure.title] });
        setFocusNext(CODE_INPUT[codeKind]);
      }
      return;
    }
    setErrors(failure.errors);
    setProblem(failure.type === 'account-locked' ? lockedProblem(failure) : failure);
  };

  const switchCode = () => {
    const next: CodeKind = codeKind === 'totp' ? 'recovery' : 'totp';
    setCodeKind(next);
    setCode('');
    setErrors({});
    setFocusNext(CODE_INPUT[next]);
  };

  const startOver = () => {
    setStep('password');
    setCode('');
    setErrors({});
    setProblem(null);
    setFocusNext('sign-in-password');
  };

  const codeErrors = [
    ...errorsFor(errors, 'code'),
    ...errorsFor(errors, codeKind === 'totp' ? 'twoFactorCode' : 'recoveryCode'),
  ];

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
      {step === 'password' ? (
        <>
          <Field id="sign-in-email" label="Email" errors={errorsFor(errors, 'email')}>
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Field id="sign-in-password" label="Password" errors={errorsFor(errors, 'password')}>
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
        </>
      ) : (
        <>
          <p className="text-sm">
            Signing in as <span className="font-medium">{email}</span>.
          </p>
          {codeKind === 'totp' ? (
            <Field
              key="totp"
              id={CODE_INPUT.totp}
              label="Authentication code"
              hint="The 6 digits your authenticator app shows for Runova."
              errors={codeErrors}
            >
              {(control) => (
                <Input
                  {...control}
                  className="font-mono tracking-widest"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={10}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              )}
            </Field>
          ) : (
            <Field
              key="recovery"
              id={CODE_INPUT.recovery}
              label="Recovery code"
              hint="One of the codes you saved when you turned on two-factor sign-in. Each works once."
              errors={codeErrors}
            >
              {(control) => (
                <Input
                  {...control}
                  className="font-mono"
                  autoComplete="off"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              )}
            </Field>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit">Sign in</Button>
        {step === 'code' && (
          <>
            <Button type="button" variant="link" className="px-0" onClick={switchCode}>
              {codeKind === 'totp'
                ? 'Use a recovery code instead'
                : 'Use an authentication code instead'}
            </Button>
            <Button type="button" variant="link" className="px-0" onClick={startOver}>
              Start over
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
