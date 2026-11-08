import { canUseRemote } from '@shared/remoteAccess';
import { useMutation } from '@tanstack/react-query';
import { SignIn } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useAccountStatus } from '@/hooks/useAccount';
import { cn } from '@/lib/utils';
import { REMOTE_CARD } from './remoteCard';

/**
 * Remote control needs a Runova sign-in. Signed in, this shows its children; otherwise a card with
 * the one step that opens them, and the children appear as soon as the sign-in finishes.
 */
export function RequireRemoteSignIn({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const { data: status } = useAccountStatus();
  const signIn = useMutation({ mutationFn: () => window.runova.account.signIn() });

  if (!status) return null;
  if (canUseRemote(status)) return <>{children}</>;

  const waiting = signIn.isPending || status.state === 'signing-in';
  return (
    <section className={cn(REMOTE_CARD, 'px-6 py-8')}>
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{text}</p>
        </div>
        <Button shape="pill" size="lg" onClick={() => signIn.mutate()} disabled={waiting}>
          <SignIn />
          {waiting ? 'Waiting for the browser…' : 'Sign in to Runova'}
        </Button>
      </div>
    </section>
  );
}
