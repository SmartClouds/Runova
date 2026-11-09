import { QrCode as QrIcon } from 'lucide-react';
import { create } from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest, type Problem } from '@/lib/account/api';
import { Card, CardHeader, Notice } from './ui';

type Status = 'waiting' | 'scanned' | 'approved' | 'declined' | 'expired';

interface Code {
  id: number;
  qrText: string;
}

interface Reading {
  status: Status;
  matchCode: string | null;
}

const FINISHED: Status[] = ['approved', 'declined', 'expired'];

/** Drawn as one SVG path, so it needs no inline HTML and no image the site's CSP would refuse. */
function QrImage({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = create(text, { errorCorrectionLevel: 'M' });
    let squares = '';
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.get(y, x)) squares += `M${x} ${y}h1v1h-1z`;
      }
    }
    return { size: modules.size, path: squares };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label="QR code to sign in"
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      className="size-44 shrink-0 rounded-inner bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

/**
 * Signs the Runova app on another device in with a QR code. The code alone is not enough: once it
 * is scanned, both screens show the same digits and that device only gets in if it is approved here.
 */
export function QrSignIn({ pollMs = 2000 }: { pollMs?: number }) {
  const [code, setCode] = useState<Code | null>(null);
  const [reading, setReading] = useState<Reading>({ status: 'waiting', matchCode: null });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  const id = code?.id;
  const status = reading.status;
  useEffect(() => {
    if (id === undefined || FINISHED.includes(status)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const response = await apiRequest<Reading>(`/qr-sign-ins/${id}`);
      if (!live) return;
      // A code the server no longer has is an old one.
      setReading(response.ok ? response.value : { status: 'expired', matchCode: null });
      timer = setTimeout(poll, pollMs);
    };
    timer = setTimeout(poll, pollMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, status, pollMs]);

  const show = async () => {
    setBusy(true);
    setProblem(null);
    const response = await apiRequest<Code>('/qr-sign-ins', { method: 'POST' });
    setBusy(false);
    if (!response.ok) {
      setProblem(response.problem);
      return;
    }
    setReading({ status: 'waiting', matchCode: null });
    setCode(response.value);
  };

  const answer = async (approve: boolean) => {
    setBusy(true);
    setProblem(null);
    const response = await apiRequest(`/qr-sign-ins/${id}/decisions`, {
      method: 'POST',
      body: { approve },
    });
    setBusy(false);
    if (!response.ok) {
      setProblem(response.problem);
      setReading({ status: 'expired', matchCode: null });
      return;
    }
    if (approve) setReading({ ...reading, status: 'approved' });
    else setCode(null);
  };

  return (
    <Card>
      <CardHeader
        icon={<QrIcon />}
        title="Sign in with a QR code"
        description="Show a code here and scan it from the sign-in screen of the Runova app on your other device."
        actions={
          code === null && (
            <Button onClick={show} disabled={busy}>
              Show QR code
            </Button>
          )
        }
      />
      <div className="grid gap-4 px-4 pb-4 sm:px-5 sm:pb-5">
        {problem && <Notice tone="danger">{problem.detail || problem.title}</Notice>}
        {code && status === 'waiting' && (
          <div className="flex flex-wrap items-center gap-5">
            <QrImage text={code.qrText} />
            <div className="grid min-w-48 flex-1 justify-items-start gap-3">
              <p className="text-muted-foreground text-sm">
                It works once and is good for two minutes.
              </p>
              <Button variant="ghost" onClick={() => answer(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {code && status === 'scanned' && (
          <div className="grid justify-items-start gap-3">
            <p className="text-muted-foreground text-sm">
              The code was scanned. Only approve if the device shows these digits.
            </p>
            <p className="font-mono font-semibold text-4xl tracking-[0.18em]">
              {reading.matchCode}
            </p>
            <div className="flex gap-2">
              <Button onClick={() => answer(true)} disabled={busy}>
                Approve
              </Button>
              <Button variant="ghost" onClick={() => answer(false)} disabled={busy}>
                Not my device
              </Button>
            </div>
          </div>
        )}
        {code && status === 'approved' && <Notice tone="success">That device is signed in.</Notice>}
        {code && (status === 'declined' || status === 'expired') && (
          <div className="grid justify-items-start gap-3">
            <Notice tone="warning">
              {status === 'expired' ? 'That code ran out.' : 'That sign-in was turned down.'}
            </Notice>
            <Button onClick={show} disabled={busy}>
              Show a new code
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
