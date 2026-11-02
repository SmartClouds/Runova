import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ArchiveRestore } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { ErrorReportingCard } from '../errorReporting/ErrorReportingCard';
import { SignInGate } from '../SignInGate';
import { useTabParam } from '../useTabParam';
import { AuditCard } from './AuditCard';
import { BackupCard } from './backup/BackupCard';
import { RestoreDialog } from './backup/RestoreDialog';
import { ChecklistCard } from './checklist/ChecklistCard';
import { CoreDomainCard } from './coreDomain/CoreDomainCard';
import { DevicesCard } from './DevicesCard';
import { DirectTlsCard } from './directTls/DirectTlsCard';
import { hasRole } from './format';
import { SECURITY_CARD } from './SecurityCard';
import { SessionsCard } from './SessionsCard';
import { UsersCard } from './UsersCard';

/** One tab, drawn as the main menu's tinted pill when it is the one shown. */
const TAB =
  'h-7 rounded-full border-none px-3 text-xs data-[state=active]:bg-primary/12 data-[state=active]:text-primary data-[state=active]:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)] data-[state=inactive]:hover:bg-foreground/[0.06] focus-visible:ring-inset';

type SecurityTab =
  | 'checklist'
  | 'users'
  | 'devices'
  | 'audit'
  | 'backups'
  | 'errorReporting'
  | 'connection';

/**
 * The tabs a role may open, so an address that names one the role cannot use (an Owner who stepped
 * down while on Users, or a remembered address from a more privileged sign-in) falls back to the
 * first tab instead of showing nothing.
 */
function tabsFor(owner: boolean, admin: boolean): SecurityTab[] {
  const tabs: SecurityTab[] = [];
  if (admin) tabs.push('checklist');
  if (owner) tabs.push('users');
  tabs.push('devices');
  if (admin) tabs.push('audit');
  if (owner) tabs.push('backups');
  if (admin) tabs.push('errorReporting');
  tabs.push('connection');
  return tabs;
}

/**
 * A server's Security area: the security checklist (Admins and Owners), who can sign in (Owners),
 * the computers enrolled and the sessions signed in (everyone's own; Admins see every computer),
 * the audit trail (Admins and Owners), backups (Owners), error reporting to Sentry (Admins read
 * it, Owners change it) and how the app reaches the core (direct TLS, which Owners change). It
 * shows only what the signed-in role may use, and the core checks
 * every call again. A backup can be restored without signing in, since that goes over SSH as
 * root: the way back for a core nobody can sign in to.
 */
export function SecurityPanel({
  server,
  onUpdateCore,
}: {
  server: DeployServer;
  /** Opens the core update (the install panel); absent for the DevHost. */
  onUpdateCore?: () => void;
}): React.JSX.Element {
  const [restoring, setRestoring] = useState(false);
  const access = useQuery({
    queryKey: queryKeys.deployAccess(server.id),
    queryFn: () => window.runova.deploy.access(server.id),
    retry: false,
    staleTime: 30_000,
  });
  // Read before the early returns below, since a hook cannot follow them.
  const signedIn = access.data?.state === 'signed-in' ? access.data : undefined;
  const owner = hasRole(signedIn?.user?.roles, 'owner');
  const admin = hasRole(signedIn?.user?.roles, 'admin');
  const [tab, setTab] = useTabParam(tabsFor(owner, admin), admin ? 'checklist' : 'devices');

  if (access.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-8 w-80 max-w-full rounded-full" />
        <div className={cn(SECURITY_CARD, 'space-y-3 p-4')}>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    );
  }

  if (access.data?.state !== 'signed-in') {
    return (
      <SignInGate server={server} purpose="see who can reach it, and from which computers">
        {!server.dev && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setRestoring(true)}>
              <ArchiveRestore className="h-3.5 w-3.5" /> Restore a backup over SSH
            </Button>
            <RestoreDialog server={server} open={restoring} onOpenChange={setRestoring} />
          </>
        )}
      </SignInGate>
    );
  }

  return (
    // The tab is in the address, so the page remembers it and it is still open when Deploy is
    // opened again. An Owner who steps down while on Users lands on the first tab they still have.
    <Tabs value={tab} onValueChange={(next) => setTab(next as SecurityTab)} className="space-y-2">
      {/* Radix tabs drawn as the kit's pill track, so arrow keys and roles stay as they were. */}
      <TabsList
        aria-label="Security"
        containerClassName="w-fit max-w-full border-b-0"
        className="search-pill mb-0 h-auto w-auto max-w-full gap-0.5 rounded-full p-0.5"
      >
        {admin && (
          <TabsTrigger value="checklist" className={TAB}>
            Checklist
          </TabsTrigger>
        )}
        {owner && (
          <TabsTrigger value="users" className={TAB}>
            Users
          </TabsTrigger>
        )}
        <TabsTrigger value="devices" className={TAB}>
          Devices and sessions
        </TabsTrigger>
        {admin && (
          <TabsTrigger value="audit" className={TAB}>
            Audit trail
          </TabsTrigger>
        )}
        {owner && (
          <TabsTrigger value="backups" className={TAB}>
            Backups
          </TabsTrigger>
        )}
        {admin && (
          <TabsTrigger value="errorReporting" className={TAB}>
            Error reporting
          </TabsTrigger>
        )}
        <TabsTrigger value="connection" className={TAB}>
          Connection
        </TabsTrigger>
      </TabsList>
      {admin && (
        <TabsContent value="checklist" className="mt-0">
          <ChecklistCard server={server} owner={owner} admin={admin} onUpdateCore={onUpdateCore} />
        </TabsContent>
      )}
      {owner && (
        <TabsContent value="users" className="mt-0">
          <UsersCard server={server} />
        </TabsContent>
      )}
      <TabsContent value="devices" className="mt-0 space-y-2">
        <DevicesCard server={server} everyone={admin} />
        <SessionsCard server={server} />
      </TabsContent>
      {admin && (
        <TabsContent value="audit" className="mt-0">
          <AuditCard server={server} />
        </TabsContent>
      )}
      {owner && (
        <TabsContent value="backups" className="mt-0">
          <BackupCard server={server} userName={access.data.user?.userName} />
        </TabsContent>
      )}
      {admin && (
        <TabsContent value="errorReporting" className="mt-0">
          <ErrorReportingCard server={server} owner={owner} onUpdateCore={onUpdateCore} />
        </TabsContent>
      )}
      <TabsContent value="connection" className="mt-0 space-y-2">
        <CoreDomainCard server={server} owner={owner} admin={admin} />
        <DirectTlsCard server={server} owner={owner} />
      </TabsContent>
    </Tabs>
  );
}
