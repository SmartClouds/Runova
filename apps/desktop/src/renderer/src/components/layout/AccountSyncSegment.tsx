import { useNavigate } from 'react-router-dom';
import {
  Cloud,
  CloudUpload,
  GitMerge,
  Lock,
  RefreshCw,
  TriangleAlert,
  Wifi,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { relativeTime, useAccountStatus, useSyncOverview } from '@/hooks/useAccount';
import { cn } from '@/lib/utils';
import { PanelTitle, PopSegment } from './statusBarKit';

/**
 * Cloud sync in the status bar (E48): synced, syncing, offline, conflicts or a key to type, with
 * the details and a way to the Account page in its panel. Hidden while signed out, so nobody who
 * never uses an account sees it.
 */
export function AccountSyncSegment(): React.JSX.Element | null {
  const status = useAccountStatus();
  const overview = useSyncOverview(status.data?.state === 'signed-in');
  const navigate = useNavigate();
  const account = status.data;
  const o = overview.data;
  if (account?.state !== 'signed-in' || !o) return null;

  const locked = o.scopes.filter((s) => s.hasKey && !s.unlockedHere);
  const view = account.needsSignIn
    ? { icon: TriangleAlert, label: 'Sign in again', tone: 'text-warning' }
    : o.conflicts > 0
      ? { icon: GitMerge, label: `${o.conflicts} to review`, tone: 'text-warning' }
      : o.phase === 'syncing'
        ? { icon: RefreshCw, label: 'Syncing', tone: '', spin: true }
        : o.phase === 'offline'
          ? { icon: Wifi, label: 'Offline', tone: 'text-muted-foreground' }
          : o.phase === 'error'
            ? { icon: TriangleAlert, label: 'Sync stopped', tone: 'text-warning' }
            : locked.length > 0
              ? { icon: Lock, label: 'Key needed', tone: 'text-primary' }
              : { icon: Cloud, label: 'Synced', tone: 'text-primary' };
  const Icon = view.icon;

  return (
    <PopSegment
      label={`Sync: ${view.label}`}
      tooltip="Cloud sync"
      panel={
        <div className="grid gap-2 text-xs">
          <PanelTitle
            title={account.account.email}
            detail={o.lastSyncedAt ? `Synced ${relativeTime(o.lastSyncedAt)}` : 'Not synced yet'}
          />
          {account.needsSignIn && (
            <p className="text-warning">
              The account signed this computer out. Sign in again to keep syncing.
            </p>
          )}
          {o.conflicts > 0 && (
            <p>
              {o.conflicts} {o.conflicts === 1 ? 'item was' : 'items were'} changed here and on
              another computer.
            </p>
          )}
          {locked.length > 0 && (
            <p>Type the key of {locked.map((s) => s.name).join(', ')} to read what is sealed.</p>
          )}
          {o.phase === 'offline' && (
            <p className="text-muted-foreground">
              Changes wait here and go out when the connection is back.
            </p>
          )}
          {o.phase === 'error' && o.error && <p className="text-warning">{o.error}</p>}
          <div className="mt-1 flex gap-2">
            <Button
              size="xs"
              shape="pill"
              variant="soft"
              onClick={() => void window.runova.sync.syncNow()}
            >
              <CloudUpload /> Sync now
            </Button>
            <Button
              size="xs"
              shape="pill"
              onClick={() =>
                navigate(o.conflicts > 0 || locked.length ? '/account?tab=sync' : '/account')
              }
            >
              Open Account
            </Button>
          </div>
        </div>
      }
    >
      <Icon
        className={cn(
          'size-3.5',
          view.tone,
          'spin' in view && view.spin && 'animate-spin motion-reduce:animate-none',
        )}
      />
      <span>{view.label}</span>
    </PopSegment>
  );
}
