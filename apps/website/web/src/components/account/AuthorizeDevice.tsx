import { Check, Globe, Laptop, LogOut, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest, type Problem } from '@/lib/account/api';
import { cn } from '@/lib/utils';
import { Notice } from './ui';

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})\/callback$/;
const PLATFORM_NAMES: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  deviceName: string;
  platform: string;
  appVersion: string | null;
  deviceId: string | null;
}

/** What the desktop app put in the link, or null when it is not a desktop sign-in link at all. */
export function readAuthorizeRequest(search: string): AuthorizeRequest | null {
  const p = new URLSearchParams(search);
  const request = {
    clientId: p.get('client_id') ?? '',
    redirectUri: p.get('redirect_uri') ?? '',
    codeChallenge: p.get('code_challenge') ?? '',
    codeChallengeMethod: p.get('code_challenge_method') ?? '',
    state: p.get('state') ?? '',
    deviceName: (p.get('device_name') ?? '').slice(0, 100),
    platform: p.get('platform') ?? '',
    appVersion: p.get('app_version'),
    deviceId: p.get('device_id'),
  };
  if (
    request.clientId !== 'runova-desktop' ||
    !LOOPBACK.test(request.redirectUri) ||
    !request.codeChallenge ||
    !request.state
  ) {
    return null;
  }
  return request;
}

/**
 * The browser side of signing the desktop app in: who is signed in here, which computer asks, and
 * one button to let it in. The browser and the computer sit side by side, and the link between
 * them lights up once it is approved.
 */
export default function AuthorizeDevice({
  email,
  navigate = (url: string) => window.location.assign(url),
}: {
  email: string;
  navigate?: (url: string) => void;
}) {
  const [request] = useState(() => readAuthorizeRequest(window.location.search));
  const [state, setState] = useState<'asking' | 'working' | 'approved' | 'declined'>('asking');
  const [problem, setProblem] = useState<Problem | null>(null);

  if (!request) {
    return (
      <>
        <h1 className="font-display font-bold text-2xl tracking-tight">
          This link is not from Runova
        </h1>
        <Notice tone="warning" className="mt-4">
          Start signing in from the Runova app on your computer: Account, then Sign in.
        </Notice>
      </>
    );
  }

  const platform = PLATFORM_NAMES[request.platform] ?? 'a computer';

  const approve = async () => {
    setState('working');
    const response = await apiRequest<{ redirectUrl: string }>('/device-authorizations', {
      method: 'POST',
      body: {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
        state: request.state,
        deviceName: request.deviceName || 'This computer',
        platform: request.platform,
        appVersion: request.appVersion,
        deviceId: request.deviceId,
      },
    });
    if (!response.ok) {
      setProblem(response.problem);
      setState('asking');
      return;
    }
    setState('approved');
    navigate(response.value.redirectUrl);
  };

  const decline = () => {
    setState('declined');
    navigate(
      `${request.redirectUri}?error=access_denied&state=${encodeURIComponent(request.state)}`,
    );
  };

  const linked = state === 'approved';
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-center gap-3 py-2" aria-hidden>
        <DeviceTile icon={<Globe />} label="This browser" active />
        <div className="relative h-0.5 w-20 overflow-hidden rounded-full bg-foreground/10 md:w-28">
          <div
            className={cn(
              'absolute inset-0 transition-opacity duration-300',
              linked ? 'opacity-100' : 'device-link opacity-60 motion-reduce:animate-none',
            )}
          />
          {linked && (
            <div className="absolute inset-0 bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.8)]" />
          )}
        </div>
        <DeviceTile icon={linked ? <Check /> : <Laptop />} label={platform} active={linked} />
      </div>

      {state === 'approved' ? (
        <div className="text-center">
          <h1 className="font-display font-bold text-2xl tracking-tight">
            {request.deviceName || 'Your computer'} is signed in
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            You can close this tab and go back to Runova. It starts syncing right away.
          </p>
        </div>
      ) : state === 'declined' ? (
        <div className="text-center">
          <h1 className="font-display font-bold text-2xl tracking-tight">Not signed in</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            Runova on that computer stays signed out. You can close this tab.
          </p>
        </div>
      ) : (
        <>
          <div className="text-center">
            <h1 className="font-display font-bold text-2xl tracking-tight">
              Sign in Runova on {request.deviceName || 'this computer'}?
            </h1>
            <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
              Runova{' '}
              {request.appVersion ? <span className="font-mono">{request.appVersion}</span> : null}{' '}
              on {platform} asks to use the account{' '}
              <span className="font-medium text-foreground">{email}</span>. It will sync your
              projects, servers and settings with your other computers.
            </p>
          </div>
          {problem && <Notice tone="danger">{problem.detail || problem.title}</Notice>}
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="ghost" onClick={decline}>
              Not now
            </Button>
            <Button onClick={approve} disabled={state === 'working'}>
              <ShieldCheck />
              {state === 'working' ? 'Signing in…' : 'Sign in this computer'}
            </Button>
          </div>
          <p className="flex items-center justify-center gap-1.5 text-muted-foreground text-xs">
            Not you?
            <a
              className="link-muted inline-flex items-center gap-1"
              href={`/account/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`}
            >
              <LogOut className="size-3" aria-hidden />
              Use another account
            </a>
          </p>
        </>
      )}
    </div>
  );
}

function DeviceTile({
  icon,
  label,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <div className="grid justify-items-center gap-2">
      <div
        className={cn(
          'flex size-14 items-center justify-center rounded-inner ring-1 transition-colors duration-300 [&_svg]:size-6',
          active
            ? 'bg-primary/12 text-primary ring-primary/30'
            : 'bg-foreground/[0.05] text-foreground/80 ring-foreground/10',
        )}
      >
        {icon}
      </div>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}
