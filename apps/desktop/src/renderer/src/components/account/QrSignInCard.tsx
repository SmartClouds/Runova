import type { QrSignInCode, QrSignInState } from '@shared/accountTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { QrCode, Smartphone } from '@/components/icons';
import { Notice, SectionCard } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { errorText } from '@/hooks/useAccount';
import { queryKeys } from '@/lib/queryKeys';

const POLL_MS = 2_000;
const FINISHED: QrSignInState[] = ['approved', 'declined', 'expired'];

/**
 * Lets the Runova app on a phone in with a QR code. The code alone is not enough: once a phone has
 * scanned it, both screens show the same digits and it only gets in if it is approved here.
 */
export function QrSignInCard(): React.JSX.Element {
  const client = useQueryClient();
  const [code, setCode] = useState<QrSignInCode | null>(null);

  const status = useQuery({
    queryKey: queryKeys.accountQrSignIn(code?.id ?? 0),
    queryFn: () => window.runova.account.qrSignInStatus((code as QrSignInCode).id),
    enabled: code !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.data && FINISHED.includes(query.state.data.status) ? false : POLL_MS,
  });
  // A code the server no longer has is an old one.
  const state: QrSignInState | null = code
    ? status.isError
      ? 'expired'
      : (status.data?.status ?? 'waiting')
    : null;

  const show = useMutation({
    mutationFn: () => window.runova.account.qrSignIn(),
    onSuccess: (next) => {
      client.removeQueries({ queryKey: queryKeys.accountQrSignIn(next.id) });
      setCode(next);
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const answer = useMutation({
    mutationFn: (approve: boolean) =>
      window.runova.account.qrSignInDecide((code as QrSignInCode).id, approve),
    onSuccess: (_result, approve) => {
      if (approve) void status.refetch();
      else setCode(null);
      void client.invalidateQueries({ queryKey: queryKeys.accountSessions });
    },
    onError: (error) => {
      toast.error(errorText(error));
      void status.refetch();
    },
  });

  const showButton = (label: string) => (
    <Button shape="pill" size="sm" onClick={() => show.mutate()} disabled={show.isPending}>
      <QrCode />
      {label}
    </Button>
  );

  return (
    <SectionCard
      icon={<Smartphone />}
      title="Sign in on your phone"
      description="Show a QR code here, then tap Scan QR code on the sign-in screen of the Runova app."
      actions={state === null ? showButton('Show QR code') : undefined}
    >
      {state === 'waiting' && code && (
        <div className="flex flex-wrap items-center gap-5">
          <img
            src={code.qrDataUrl}
            alt="QR code to sign in the Runova app"
            className="size-44 rounded-lg bg-white p-1"
          />
          <div className="flex min-w-48 flex-1 flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              Point the phone at this code. It works once and is good for two minutes.
            </p>
            <Button shape="pill" size="sm" variant="ghost" onClick={() => answer.mutate(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {state === 'scanned' && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            A phone scanned the code. Only approve it if it shows these digits.
          </p>
          <p className="font-mono text-4xl font-semibold tracking-[0.18em]">
            {status.data?.matchCode}
          </p>
          <div className="flex gap-2">
            <Button
              shape="pill"
              size="sm"
              onClick={() => answer.mutate(true)}
              disabled={answer.isPending}
            >
              Approve
            </Button>
            <Button
              shape="pill"
              size="sm"
              variant="ghost"
              onClick={() => answer.mutate(false)}
              disabled={answer.isPending}
            >
              Not my phone
            </Button>
          </div>
        </div>
      )}
      {state === 'approved' && <Notice tone="success">Your phone is signed in.</Notice>}
      {(state === 'declined' || state === 'expired') && (
        <Notice tone="neutral" action={showButton('Show a new code')}>
          {state === 'expired' ? 'That code ran out.' : 'That sign-in was turned down.'}
        </Notice>
      )}
    </SectionCard>
  );
}
