import { Copy, Fingerprint, KeyRound, Link2, Pencil, Smartphone, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Field } from '@/components/admin/Field';
import { Button } from '@/components/ui/button';
import { type Account, apiRequest, type Passkey } from '@/lib/account/api';
import { passkeysSupported, runPasskey } from '@/lib/account/passkeys';
import { useSignInOptions } from '@/lib/account/signInOptions';
import { StrengthMeter } from './AuthForms';
import { AppInput, PasswordInput } from './fields';
import {
  isProvider,
  knownProviders,
  PROVIDERS,
  type ProviderName,
  providerLabel,
  providerStart,
} from './providers';
import { Card, CardHeader, Notice, PageHeader, Pill, Shimmer, StepUpDialog, useLoad } from './ui';

/** The providers a password-less account signs in with, in words: "Apple", "Google or Apple". */
const signsInWith = (account: Account) => {
  const names = account.logins.map(providerLabel);
  return names.length === 0 ? 'a passkey' : names.join(' or ');
};

/** What Security says when the browser comes back from linking a provider. */
function readLinkMessage(query: string): { tone: 'success' | 'warning'; text: string } | null {
  const params = new URLSearchParams(query);
  const linked = params.get('linked');
  if (linked && isProvider(linked)) {
    return {
      tone: 'success',
      text: `${PROVIDERS[linked].label} is linked. You can sign in with it from now on.`,
    };
  }
  const error = params.get('error');
  if (error === 'login-taken') {
    return { tone: 'warning', text: 'That account already signs in to another Runova account.' };
  }
  const failed = error && /^(.+)-failed$/.exec(error)?.[1];
  if (failed && isProvider(failed)) {
    return {
      tone: 'warning',
      text: `${PROVIDERS[failed].label} did not finish. Try linking again.`,
    };
  }
  return null;
}

export default function Security() {
  const account = useLoad<Account>('/accounts/me');
  const twoFactor = useLoad<{ enabled: boolean; recoveryCodesLeft: number }>(
    '/users/me/two-factor',
  );
  const me = account.value;
  const query = typeof window === 'undefined' ? '' : window.location.search.slice(1);
  const linkMessage = readLinkMessage(query);
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
          <PasskeysCard account={me} reloadAccount={account.reload} />
          <ConnectedAccountsCard account={me} reload={account.reload} />
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
          description={`You sign in with ${signsInWith(account)}. Add a password too, so you can sign in if you ever lose that account.`}
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
      <form onSubmit={save} className="grid gap-4 px-4 pb-4 sm:px-5 sm:pb-5 md:grid-cols-2">
        <Field id="current" label="Current password" errors={errors.currentPassword}>
          {(control) => (
            <PasswordInput
              {...control}
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
              <PasswordInput
                {...control}
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
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <Button type="submit" className="w-full sm:w-auto">
            Change password
          </Button>
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
        <form onSubmit={confirm} className="grid gap-4 px-4 pb-4 sm:px-5 sm:pb-5">
          <ol className="grid gap-3 text-sm">
            <li>
              <span className="font-medium">1. Add Runova to your authenticator app</span> with this
              key, or open the link on your phone.
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="app-field break-all rounded-inner px-3.5 py-1.5 font-mono text-sm tracking-wider sm:rounded-full">
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
          <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-end">
            <Field id="totp" label="Code" errors={error ? [error] : undefined}>
              {(control) => (
                <AppInput
                  {...control}
                  className="w-full font-mono tracking-[0.2em] sm:w-40"
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

/**
 * Google, Apple and Microsoft (E116): link each one the site has on, and unlink one that is linked
 * even while the site has it off. The API refuses to unlink the last way in.
 */
function ConnectedAccountsCard({ account, reload }: { account: Account; reload: () => void }) {
  const options = useSignInOptions();
  const [problem, setProblem] = useState<string | null>(null);
  const offered = knownProviders(options?.providers);
  const shown = (Object.keys(PROVIDERS) as ProviderName[]).filter(
    (name) => account.logins.includes(name) || offered.includes(name),
  );
  const unlink = async (name: ProviderName) => {
    setProblem(null);
    const response = await apiRequest(`/accounts/me/logins/${name}`, { method: 'DELETE' });
    if (response.ok) reload();
    else setProblem(response.problem.detail || response.problem.title);
  };
  if (shown.length === 0) return null;
  return (
    <Card>
      <CardHeader
        icon={<Link2 />}
        title="Connected accounts"
        description="Sign in with another account as well as your password or passkey."
      />
      <ul className="grid gap-2 px-5 pb-5">
        {shown.map((name) => {
          const { label, Mark } = PROVIDERS[name];
          const linked = account.logins.includes(name);
          return (
            <li
              key={name}
              aria-label={label}
              className="flex items-center justify-between gap-3 rounded-inner app-field px-3 py-2"
            >
              <span className="flex items-center gap-2.5 font-medium text-sm">
                <Mark />
                {label}
                {linked && <Pill tone="success">Linked</Pill>}
              </span>
              {linked ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Unlink ${label}`}
                  onClick={() => unlink(name)}
                >
                  Unlink
                </Button>
              ) : (
                <Button asChild size="sm" variant="outline" className="app-field border-0">
                  <a href={providerStart(name, '/account/security', true)}>{`Link ${label}`}</a>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {problem && (
        <div className="px-5 pb-5">
          <Notice tone="warning">{problem}</Notice>
        </div>
      )}
    </Card>
  );
}

const added = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * Passkeys (E115): sign in with a fingerprint, face or PIN instead of a password and code. Adding
 * and removing one asks for the usual proof, which another passkey can give.
 */
function PasskeysCard({ account, reloadAccount }: { account: Account; reloadAccount: () => void }) {
  const list = useLoad<{ items: Passkey[] }>('/users/me/passkeys');
  const [supported] = useState(passkeysSupported);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const passkeys = list.value?.items ?? [];
  const reload = () => {
    void list.reload();
    reloadAccount();
  };
  const rename = async (passkey: Passkey) => {
    const response = await apiRequest(`/users/me/passkeys/${passkey.id}`, {
      method: 'PATCH',
      body: { name: newName.trim() },
    });
    if (!response.ok) {
      setRenameError(Object.values(response.problem.errors).flat()[0] ?? response.problem.detail);
      return;
    }
    setRenaming(null);
    setRenameError(null);
    void list.reload();
  };
  return (
    <Card>
      <CardHeader
        icon={<Fingerprint />}
        title="Passkeys"
        description="Sign in with your fingerprint, face or screen lock instead of a password. No code needed."
        actions={
          supported && (
            <Button
              size="sm"
              variant="outline"
              className="app-field border-0"
              onClick={() => {
                setName('');
                setAdding(true);
              }}
            >
              Add a passkey
            </Button>
          )
        }
      />
      <div className="grid gap-3 px-4 pb-4 sm:px-5 sm:pb-5">
        {!supported && (
          <p className="text-muted-foreground text-sm">
            This browser can not make passkeys. Add one from a browser or phone that can.
          </p>
        )}
        {passkeys.length > 0 && (
          <ul className="grid gap-2">
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="app-field flex flex-wrap items-center gap-3 rounded-inner px-3 py-2 text-sm"
              >
                {renaming === passkey.id ? (
                  <form
                    className="flex flex-1 flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void rename(passkey);
                    }}
                  >
                    <AppInput
                      aria-label={`New name for ${passkey.name}`}
                      value={newName}
                      maxLength={50}
                      onChange={(e) => setNewName(e.target.value)}
                      className="h-8 max-w-64 flex-1"
                      required
                      autoFocus
                    />
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </Button>
                    {renameError && (
                      <span className="w-full text-destructive text-xs" role="alert">
                        {renameError}
                      </span>
                    )}
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{passkey.name}</p>
                      <p className="text-muted-foreground text-xs">
                        Added {added(passkey.createdAt)}
                        {passkey.synced ? ' · Synced between your devices' : ' · On one device'}
                      </p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Rename ${passkey.name}`}
                      onClick={() => {
                        setNewName(passkey.name);
                        setRenameError(null);
                        setRenaming(passkey.id);
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${passkey.name}`}
                      onClick={() => setRemoving(passkey)}
                    >
                      <Trash2 />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <StepUpDialog
        open={adding}
        title="Add a passkey"
        description="Your browser or phone asks you to make the passkey next. It stays on that device, or in the password manager that holds it."
        confirm="Add passkey"
        hasPassword={account.hasPassword}
        twoFactor={account.twoFactorEnabled}
        passkeys={account.passkeyCount > 0}
        onClose={() => setAdding(false)}
        onConfirm={async (stepUp) => {
          const ceremony = await runPasskey('register');
          if (!ceremony.ok) {
            return {
              credential: [
                ceremony.cancelled
                  ? 'No passkey was made. Try again when you are ready.'
                  : ceremony.message,
              ],
            };
          }
          const response = await apiRequest('/users/me/passkeys', {
            method: 'POST',
            body: {
              challengeId: ceremony.challengeId,
              credential: ceremony.credential,
              name: name.trim(),
              ...stepUp,
            },
          });
          if (!response.ok) return response.problem.errors;
          setAdding(false);
          reload();
          return null;
        }}
      >
        <Field id="passkey-name" label="Name it">
          {(control) => (
            <AppInput
              {...control}
              placeholder="Work laptop"
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
      </StepUpDialog>
      <StepUpDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'this passkey'}?`}
        description="It stops signing you in at once. Remove it from the device or password manager too."
        confirm="Remove"
        destructive
        hasPassword={account.hasPassword}
        twoFactor={account.twoFactorEnabled}
        passkeys={account.passkeyCount > 0}
        onClose={() => setRemoving(null)}
        onConfirm={async (stepUp) => {
          if (!removing) return null;
          const response = await apiRequest(`/users/me/passkeys/${removing.id}`, {
            method: 'DELETE',
            body: stepUp,
          });
          if (!response.ok) return response.problem.errors;
          setRemoving(null);
          reload();
          return null;
        }}
      />
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
        passkeys={account.passkeyCount > 0}
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
