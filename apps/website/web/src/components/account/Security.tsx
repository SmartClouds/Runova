import { Copy, KeyRound, Link2, Smartphone, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Field } from '@/components/admin/Field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type Account, apiRequest } from '@/lib/account/api';
import { StrengthMeter } from './AuthForms';
import { Card, CardHeader, Notice, PageHeader, Pill, Shimmer, StepUpDialog, useLoad } from './ui';

const LINK_MESSAGES: Record<string, { tone: 'success' | 'warning'; text: string }> = {
  'linked=google': {
    tone: 'success',
    text: 'Google is linked. You can sign in with it from now on.',
  },
  'error=login-taken': {
    tone: 'warning',
    text: 'That Google account already signs in to another Runova account.',
  },
  'error=google-failed': { tone: 'warning', text: 'Google did not finish. Try linking again.' },
};

export default function Security() {
  const account = useLoad<Account>('/accounts/me');
  const twoFactor = useLoad<{ enabled: boolean; recoveryCodesLeft: number }>(
    '/users/me/two-factor',
  );
  const me = account.value;
  const query = typeof window === 'undefined' ? '' : window.location.search.slice(1);
  const linkMessage = LINK_MESSAGES[query];
  return (
    <>
      <PageHeader
        title="Security"
        description="How you sign in, and what protects your account if a password leaks."
      />
      {linkMessage && (
        <Notice tone={linkMessage.tone} className="mb-4">
          {linkMessage.text}
        </Notice>
      )}
      {!me ? (
        <Card>
          <Shimmer lines={5} />
        </Card>
      ) : (
        <div className="grid gap-4">
          <PasswordCard account={me} />
          <TwoFactorCard
            enabled={twoFactor.value?.enabled ?? me.twoFactorEnabled}
            left={twoFactor.value?.recoveryCodesLeft ?? 0}
            hasPassword={me.hasPassword}
            reload={() => {
              void twoFactor.reload();
              void account.reload();
            }}
          />
          <GoogleCard account={me} reload={account.reload} />
          <DeleteCard account={me} />
        </div>
      )}
    </>
  );
}

function PasswordCard({ account }: { account: Account }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [done, setDone] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const save = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    const response = await apiRequest('/users/me/password', {
      method: 'PUT',
      body: { currentPassword: current, newPassword: next },
    });
    if (response.ok) {
      setDone(true);
      setCurrent('');
      setNext('');
      setErrors({});
    } else setErrors(response.problem.errors);
  };
  if (!account.hasPassword) {
    return (
      <Card>
        <CardHeader
          icon={<KeyRound />}
          title="Password"
          description="You sign in with Google. Add a password too, so you can sign in if you ever lose that Google account."
          actions={
            <Button
              size="sm"
              variant="outline"
              className="app-field border-0"
              onClick={async () => {
                await apiRequest('/password-resets', {
                  method: 'POST',
                  body: { email: account.email },
                });
                setLinkSent(true);
              }}
            >
              Email me a link to set one
            </Button>
          }
        />
        {linkSent && (
          <div className="px-5 pb-5">
            <Notice tone="success">
              The link is on its way to {account.email}. It works for one hour.
            </Notice>
          </div>
        )}
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader
        icon={<KeyRound />}
        title="Password"
        description="Changing it signs out every other browser and computer."
      />
      <form onSubmit={save} className="grid gap-4 px-5 pb-5 md:grid-cols-2">
        <Field id="current" label="Current password" errors={errors.currentPassword}>
          {(control) => (
            <Input
              {...control}
              className="app-field"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          )}
        </Field>
        <Field id="new" label="New password" errors={errors.newPassword}>
          {(control) => (
            <div className="grid gap-2">
              <Input
                {...control}
                className="app-field"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                minLength={12}
              />
              <StrengthMeter password={next} />
            </div>
          )}
        </Field>
        <div className="flex items-center gap-3 md:col-span-2">
          <Button type="submit">Change password</Button>
          {done && (
            <span className="text-success text-sm">
              Changed. Your other devices are signed out.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function TwoFactorCard({
  enabled,
  left,
  hasPassword,
  reload,
}: {
  enabled: boolean;
  left: number;
  hasPassword: boolean;
  reload: () => void;
}) {
  const [setup, setSetup] = useState<{ sharedKey: string; authenticatorUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const start = async () => {
    const response = await apiRequest<{ sharedKey: string; authenticatorUri: string }>(
      '/users/me/two-factor',
      { method: 'POST' },
    );
    if (response.ok) setSetup(response.value);
  };
  const confirm = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    const response = await apiRequest<{ recoveryCodes: string[] }>('/users/me/two-factor', {
      method: 'PUT',
      body: { code: code.replace(/\s/g, '') },
    });
    if (response.ok) {
      setCodes(response.value.recoveryCodes);
      setSetup(null);
      reload();
    } else setError(response.problem.errors.code?.[0] ?? response.problem.detail);
  };
  return (
    <Card>
      <CardHeader
        icon={<Smartphone />}
        title={
          <span className="flex items-center gap-2">
            Two-factor sign-in{' '}
            {enabled ? <Pill tone="success">On</Pill> : <Pill tone="warning">Off</Pill>}
          </span>
        }
        description={
          enabled
            ? `A code from your authenticator app is asked after your password. ${left} recovery codes left.`
            : 'Ask for a code from an authenticator app after your password, so a leaked password is not enough.'
        }
        actions={
          enabled
            ? hasPassword && (
                <Button size="sm" variant="ghost" onClick={() => setTurningOff(true)}>
                  Turn off
                </Button>
              )
            : !setup && (
                <Button size="sm" onClick={start}>
                  Turn on
                </Button>
              )
        }
      />
      {setup && (
        <form onSubmit={confirm} className="grid gap-4 px-5 pb-5">
          <ol className="grid gap-3 text-sm">
            <li>
              <span className="font-medium">1. Add Runova to your authenticator app</span> with this
              key, or open the link on your phone.
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="app-field rounded-inner px-3 py-1.5 font-mono text-sm tracking-wider">
                  {setup.sharedKey.match(/.{1,4}/g)?.join(' ')}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => navigator.clipboard.writeText(setup.sharedKey)}
                >
                  <Copy /> Copy
                </Button>
                <a className="link text-xs" href={setup.authenticatorUri}>
                  Open in an authenticator app
                </a>
              </div>
            </li>
            <li className="font-medium">2. Enter the 6-digit code it shows.</li>
          </ol>
          <div className="flex flex-wrap items-end gap-3">
            <Field id="totp" label="Code" errors={error ? [error] : undefined}>
              {(control) => (
                <Input
                  {...control}
                  className="app-field w-40 font-mono tracking-[0.2em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoFocus
                />
              )}
            </Field>
            <Button type="submit">Turn on two-factor</Button>
          </div>
        </form>
      )}
      {codes && (
        <div className="px-5 pb-5">
          <Notice
            tone="success"
            title="Two-factor is on. Keep these recovery codes somewhere safe."
          >
            <p>Each works once if you lose your phone. They are shown only now.</p>
            <ul className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-foreground text-sm sm:grid-cols-5">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => navigator.clipboard.writeText(codes.join('\n'))}
            >
              <Copy /> Copy all
            </Button>
          </Notice>
        </div>
      )}
      <StepUpDialog
        open={turningOff}
        title="Turn off two-factor?"
        description="Your password alone will be enough to sign in again."
        confirm="Turn off"
        destructive
        hasPassword
        twoFactor={false}
        onClose={() => setTurningOff(false)}
        onConfirm={async (stepUp) => {
          const response = await apiRequest('/users/me/two-factor', {
            method: 'DELETE',
            body: { password: stepUp.password },
          });
          if (!response.ok) return response.problem.errors;
          setTurningOff(false);
          reload();
          return null;
        }}
      />
    </Card>
  );
}

function GoogleCard({ account, reload }: { account: Account; reload: () => void }) {
  const linked = account.logins.includes('google');
  const [problem, setProblem] = useState<string | null>(null);
  const unlink = async () => {
    const response = await apiRequest('/accounts/me/logins/google', { method: 'DELETE' });
    if (response.ok) reload();
    else setProblem(response.problem.detail);
  };
  return (
    <Card>
      <CardHeader
        icon={<Link2 />}
        title={
          <span className="flex items-center gap-2">
            Google {linked && <Pill tone="success">Linked</Pill>}
          </span>
        }
        description={
          linked
            ? 'You can sign in with your Google account.'
            : 'Sign in with your Google account as well as your password.'
        }
        actions={
          linked ? (
            <Button size="sm" variant="ghost" onClick={unlink}>
              Unlink
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline" className="app-field border-0">
              <a href="/api/v1/external-sign-ins/google?link=true&returnUrl=%2Faccount%2Fsecurity">
                Link Google
              </a>
            </Button>
          )
        }
      />
      {problem && (
        <div className="px-5 pb-5">
          <Notice tone="warning">{problem}</Notice>
        </div>
      )}
    </Card>
  );
}

function DeleteCard({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  if (account.staff) return null;
  return (
    <Card className="ring-1 ring-destructive/20">
      <CardHeader
        icon={<Trash2 />}
        tone="destructive"
        title="Delete your account"
        description="Your synced data, sessions and team memberships go with it. Data on your computers stays there. This can not be undone."
        actions={
          <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
            Delete account
          </Button>
        }
      />
      {blocked && (
        <div className="px-5 pb-5">
          <Notice tone="warning">{blocked}</Notice>
        </div>
      )}
      <StepUpDialog
        open={open}
        title="Delete your Runova account?"
        description={
          <>
            Everything stored for <strong className="text-foreground">{account.email}</strong> is
            deleted at once. Your computers sign out.
          </>
        }
        confirm="Delete for good"
        destructive
        hasPassword={account.hasPassword}
        twoFactor={account.twoFactorEnabled}
        onClose={() => setOpen(false)}
        onConfirm={async (stepUp) => {
          const response = await apiRequest('/accounts/me', { method: 'DELETE', body: stepUp });
          if (response.ok) {
            window.location.assign('/');
            return null;
          }
          if (response.problem.status === 409) {
            setOpen(false);
            setBlocked(response.problem.detail);
            return null;
          }
          return response.problem.errors;
        }}
      />
    </Card>
  );
}
