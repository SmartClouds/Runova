import { ArrowRight, MailCheck } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Field } from '@/components/admin/Field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest, type Problem, safeAccountPath } from '@/lib/account/api';
import { Notice } from './ui';

const goTo = (path: string) => window.location.assign(path);

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z"
      />
    </svg>
  );
}

/** "Continue with Google", shown only when the API says Google sign-in is set up. */
function GoogleButton({ next }: { next: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    void apiRequest<{ items: string[] }>('/sign-in-providers').then((r) =>
      setShown(r.ok && r.value.items.includes('google')),
    );
  }, []);
  if (!shown) return null;
  return (
    <>
      <Button asChild variant="outline" className="w-full app-field border-0">
        <a href={`/api/v1/external-sign-ins/google?returnUrl=${encodeURIComponent(next)}`}>
          <GoogleMark />
          Continue with Google
        </a>
      </Button>
      <div className="flex items-center gap-3 text-muted-foreground text-xs">
        <span className="h-px flex-1 bg-foreground/10" />
        or with your email
        <span className="h-px flex-1 bg-foreground/10" />
      </div>
    </>
  );
}

function Title({ children, lead }: { children: ReactNode; lead?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="font-display font-bold text-2xl tracking-tight">{children}</h1>
      {lead && <p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">{lead}</p>}
    </div>
  );
}

const GOOGLE_ERRORS: Record<string, string> = {
  'google-failed': 'Google did not finish signing you in. Try again.',
  'email-unverified': 'Google has not confirmed that email address, so Runova can not use it.',
  'link-needed':
    'An account with that email already exists. Sign in with its password, then link Google from Security.',
  disabled: 'This account is turned off. Contact support to turn it back on.',
  locked: 'Too many tries in a row. Wait a few minutes and try again.',
};

export function SignIn({ navigate = goTo }: { navigate?: (path: string) => void }) {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const next = safeAccountPath(params.get('next') ?? params.get('returnUrl'));
  const googleTwoFactor = params.get('step') === 'two-factor';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'password' | 'code'>(googleTwoFactor ? 'code' : 'password');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const [busy, setBusy] = useState(false);
  const googleError = params.get('error');

  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const cleaned = useRecovery ? code.trim() : code.replace(/\s/g, '');
    const response = googleTwoFactor
      ? await apiRequest('/two-factor-sign-ins', {
          method: 'POST',
          body: { code: useRecovery ? null : cleaned, recoveryCode: useRecovery ? cleaned : null },
        })
      : await apiRequest('/sessions', {
          method: 'POST',
          body: {
            email,
            password,
            twoFactorCode: step === 'code' && !useRecovery ? cleaned : null,
            recoveryCode: step === 'code' && useRecovery ? cleaned : null,
          },
        });
    setBusy(false);
    if (response.ok) {
      navigate(next);
      return;
    }
    const failure = response.problem;
    if (failure.type === 'two-factor-required' && step === 'password') {
      setStep('code');
      return;
    }
    if (failure.type === 'email-unverified') setUnverified(true);
    setProblem(failure);
  };

  const resend = async () => {
    await apiRequest('/verification-emails', { method: 'POST', body: { email } });
    setResent(true);
  };

  return (
    <>
      <Title
        lead={
          step === 'code'
            ? 'Open your authenticator app and enter the 6-digit code for Runova.'
            : 'Welcome back. Sign in to sync this computer and manage your devices.'
        }
      >
        {step === 'code' ? 'Two-step check' : 'Sign in to Runova'}
      </Title>
      <div className="grid gap-4">
        {googleError && GOOGLE_ERRORS[googleError] && (
          <Notice tone="warning">{GOOGLE_ERRORS[googleError]}</Notice>
        )}
        {problem && !unverified && <Notice tone="danger">{problem.detail || problem.title}</Notice>}
        {unverified && (
          <Notice tone="warning" title="Confirm your email first">
            {resent ? (
              <p>A new link is on its way to {email}. Open it to finish.</p>
            ) : (
              <p>
                Open the link we sent to {email}.{' '}
                <button type="button" className="link" onClick={resend}>
                  Send a new link
                </button>
              </p>
            )}
          </Notice>
        )}
        {step === 'password' && <GoogleButton next={next} />}
        <form onSubmit={submit} className="grid gap-4">
          {step === 'password' ? (
            <>
              <Field id="email" label="Email">
                {(control) => (
                  <Input
                    {...control}
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                )}
              </Field>
              <Field
                id="password"
                label={
                  <span className="flex w-full justify-between">
                    Password
                    <a href="/account/forgot-password" className="link-muted font-normal text-xs">
                      Forgot it?
                    </a>
                  </span>
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                )}
              </Field>
            </>
          ) : (
            <Field id="code" label={useRecovery ? 'Recovery code' : 'Code'}>
              {(control) => (
                <Input
                  {...control}
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  className="font-mono tracking-[0.2em]"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoFocus
                />
              )}
            </Field>
          )}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
            {!busy && <ArrowRight />}
          </Button>
          {step === 'code' && (
            <button
              type="button"
              className="link-muted text-sm"
              onClick={() => setUseRecovery((v) => !v)}
            >
              {useRecovery ? 'Use the authenticator code' : 'Use a recovery code instead'}
            </button>
          )}
        </form>
        {step === 'password' && (
          <p className="text-center text-muted-foreground text-sm">
            New to Runova?{' '}
            <a
              className="link"
              href={`/account/register${next !== '/account' ? `?next=${encodeURIComponent(next)}` : ''}`}
            >
              Make an account
            </a>
          </p>
        )}
      </div>
    </>
  );
}

/** A rough guide to how hard a password is to guess, shown while typing. Never blocks. */
function strength(password: string): { score: number; label: string } {
  if (!password) return { score: 0, label: '' };
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;
  const bits =
    password.length * Math.log2(Math.max(pool, 1)) * (new Set(password).size / password.length);
  const score = bits < 36 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { score, label: ['', 'Weak', 'Fair', 'Strong', 'Very strong'][score] as string };
}

export function StrengthMeter({ password }: { password: string }) {
  const { score, label } = strength(password);
  return (
    <div className="flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1">
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={`h-1 flex-1 rounded-full transition-colors duration-200 ${step <= score ? (score <= 1 ? 'bg-destructive' : score === 2 ? 'bg-warning' : 'bg-primary') : 'bg-foreground/10'}`}
          />
        ))}
      </div>
      <span className="w-20 text-right text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

export function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setBusy(true);
    const response = await apiRequest('/accounts', {
      method: 'POST',
      body: { email, password, displayName: name },
    });
    setBusy(false);
    if (response.ok) {
      setSentTo(email);
      return;
    }
    setErrors(response.problem.errors);
    setProblem(Object.keys(response.problem.errors).length ? null : response.problem);
  };

  if (sentTo) {
    return (
      <div className="grid justify-items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/12 text-primary">
          <MailCheck className="size-6" aria-hidden />
        </div>
        <Title
          lead={`We sent a link to ${sentTo}. Open it on any device to confirm your email and finish.`}
        >
          Check your email
        </Title>
        <p className="text-muted-foreground text-sm">
          Nothing there after a few minutes? Look in spam, or{' '}
          <button
            type="button"
            className="link"
            onClick={() =>
              apiRequest('/verification-emails', { method: 'POST', body: { email: sentTo } })
            }
          >
            send it again
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <>
      <Title lead="Sign in on every computer and your projects, servers and settings come with you.">
        Make your Runova account
      </Title>
      <div className="grid gap-4">
        <GoogleButton next="/account" />
        {problem && <Notice tone="danger">{problem.detail || problem.title}</Notice>}
        <form onSubmit={submit} className="grid gap-4">
          <Field id="name" label="Your name" errors={errors.displayName}>
            {(control) => (
              <Input
                {...control}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
                autoFocus
              />
            )}
          </Field>
          <Field id="email" label="Email" errors={errors.email}>
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            )}
          </Field>
          <Field
            id="password"
            label="Password"
            hint="12 characters or more. A few unrelated words make a strong one."
            errors={errors.password}
          >
            {(control) => (
              <div className="grid gap-2">
                <Input
                  {...control}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={12}
                />
                <StrengthMeter password={password} />
              </div>
            )}
          </Field>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Making your account…' : 'Make account'}
          </Button>
        </form>
        <p className="text-center text-muted-foreground text-sm">
          Have an account already?{' '}
          <a className="link" href="/account/sign-in">
            Sign in
          </a>
        </p>
      </div>
    </>
  );
}

function tokenFromHash(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
}

export function VerifyEmail({ navigate = goTo }: { navigate?: (path: string) => void }) {
  const [state, setState] = useState<'working' | 'signed-in' | 'confirmed' | 'failed'>('working');
  const [problem, setProblem] = useState<Problem | null>(null);
  useEffect(() => {
    const token = tokenFromHash();
    // The token leaves the address bar at once, so it is not left in history.
    window.history.replaceState(null, '', window.location.pathname);
    void apiRequest<{ signedIn: boolean }>('/email-verifications', {
      method: 'POST',
      body: { token },
    }).then((r) => {
      if (r.ok) {
        setState(r.value.signedIn ? 'signed-in' : 'confirmed');
        if (r.value.signedIn) setTimeout(() => navigate('/account'), 1200);
      } else {
        setProblem(r.problem);
        setState('failed');
      }
    });
  }, [navigate]);
  if (state === 'working') return <Title lead="One moment.">Confirming your email</Title>;
  if (state === 'failed') {
    return (
      <>
        <Title>That link did not work</Title>
        <Notice tone="danger">
          {problem?.detail || 'The link may have been used already, or it expired.'}
        </Notice>
        <p className="mt-4 text-muted-foreground text-sm">
          Sign in to ask for a new one:{' '}
          <a className="link" href="/account/sign-in">
            Sign in
          </a>
        </p>
      </>
    );
  }
  return (
    <>
      <Title
        lead={
          state === 'signed-in'
            ? 'You are signed in. Taking you to your account.'
            : 'Sign in to finish.'
        }
      >
        Email confirmed
      </Title>
      <Notice tone="success">Your account is ready to use on every computer.</Notice>
      {state === 'confirmed' && (
        <Button asChild className="mt-4 w-full">
          <a href="/account/sign-in">Sign in</a>
        </Button>
      )}
    </>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string[] | undefined>();
  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    const response = await apiRequest('/password-resets', { method: 'POST', body: { email } });
    if (response.ok) setSent(true);
    else setError(response.problem.errors.email ?? [response.problem.detail]);
  };
  if (sent) {
    return (
      <>
        <Title
          lead={`If ${email} has a Runova account, a link to pick a new password is on its way. It works for one hour.`}
        >
          Check your email
        </Title>
        <a className="link text-sm" href="/account/sign-in">
          Back to sign in
        </a>
      </>
    );
  }
  return (
    <>
      <Title lead="Enter the email of your account and we will send a link to pick a new password.">
        Forgot your password?
      </Title>
      <form onSubmit={submit} className="grid gap-4">
        <Field id="email" label="Email" errors={error}>
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          )}
        </Field>
        <Button type="submit" className="w-full">
          Send the link
        </Button>
        <a className="link-muted text-center text-sm" href="/account/sign-in">
          Back to sign in
        </a>
      </form>
    </>
  );
}

export function ResetPassword() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  useEffect(() => {
    setToken(tokenFromHash());
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    const response = await apiRequest('/password-setups', {
      method: 'POST',
      body: { token, password },
    });
    if (response.ok) setDone(true);
    else {
      setErrors(response.problem.errors);
      setProblem(Object.keys(response.problem.errors).length ? null : response.problem);
    }
  };
  if (done) {
    return (
      <>
        <Title lead="Every other browser and computer was signed out. Sign in again with the new password.">
          Password changed
        </Title>
        <Button asChild className="w-full">
          <a href="/account/sign-in">Sign in</a>
        </Button>
      </>
    );
  }
  return (
    <>
      <Title lead="Pick a new password for your Runova account.">Choose a new password</Title>
      {problem && (
        <Notice tone="danger" className="mb-4">
          {problem.detail || problem.title}
        </Notice>
      )}
      <form onSubmit={submit} className="grid gap-4">
        <Field
          id="password"
          label="New password"
          hint="12 characters or more."
          errors={errors.password}
        >
          {(control) => (
            <div className="grid gap-2">
              <Input
                {...control}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                autoFocus
              />
              <StrengthMeter password={password} />
            </div>
          )}
        </Field>
        <Button type="submit" className="w-full">
          Save the new password
        </Button>
      </form>
    </>
  );
}
