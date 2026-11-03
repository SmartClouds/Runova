import type { AiExternalClientId, AiExternalClientStatus } from '@shared/aiAccessTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Link } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { queryKeys } from '@/lib/queryKeys';
import { useAiAccessSettings } from './useAiAccessSettings';

/**
 * Settings > AI access > Connect other apps: adds Runova's MCP server to the CLIs the user runs in
 * their own terminal, with each CLI's own command, and gives a config block for any other app.
 */

function ClientRow({ client }: { client: AiExternalClientStatus }): React.JSX.Element {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: async (action: 'connect' | 'disconnect') => {
      const id: AiExternalClientId = client.id;
      return action === 'connect'
        ? window.runova.aiAccess.connectExternal(id)
        : window.runova.aiAccess.disconnectExternal(id);
    },
    onSuccess: (result, action) => {
      if (!result.ok) {
        toast.error(result.error ?? `${client.label} did not accept the change.`);
        return;
      }
      toast.success(
        action === 'connect'
          ? `Added Runova to ${client.label}. Start a new ${client.label} session to use it.`
          : `Removed Runova from ${client.label}.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiAccessExternal });
    },
  });

  return (
    <li className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{client.label}</p>
        <p className="text-xs text-muted-foreground">
          {client.connected
            ? 'Runova is in its MCP list for every project.'
            : client.installed
              ? 'Adds Runova to its MCP list for every project.'
              : 'Not found on this machine.'}
        </p>
      </div>
      {client.connected ? (
        <>
          <Badge variant="success" className="gap-1">
            <Check className="h-3 w-3" />
            Connected
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove from ${client.label}`}
            disabled={change.isPending}
            onClick={() => change.mutate('disconnect')}
          >
            Remove
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="soft"
          size="sm"
          aria-label={`Add to ${client.label}`}
          disabled={!client.installed || change.isPending}
          onClick={() => change.mutate('connect')}
        >
          Add
        </Button>
      )}
    </li>
  );
}

export function AiAccessConnectCard(): React.JSX.Element {
  const { values, save } = useAiAccessSettings();
  const othersAllowed = values.clients !== 'runova';
  const status = useQuery({
    queryKey: queryKeys.aiAccessExternal,
    queryFn: () => window.runova.aiAccess.externalStatus(),
    enabled: othersAllowed,
  });

  async function copyConfig(): Promise<void> {
    try {
      await navigator.clipboard.writeText(await window.runova.aiAccess.configSnippet());
      toast.success('Copied. Paste it into the MCP settings of the app you use.');
    } catch {
      toast.error('Could not copy the config.');
    }
  }

  return (
    <Card className="glass">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Link className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle>Connect other apps</CardTitle>
            <CardDescription>
              Use Runova from a CLI in your own terminal or from your editor. The project is picked
              from the folder the agent runs in.
            </CardDescription>
          </div>
        </div>
        {othersAllowed ? (
          <Button
            type="button"
            variant="soft"
            size="sm"
            className="gap-1.5"
            onClick={() => void copyConfig()}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy config
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {othersAllowed ? (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-background/40">
            {(status.data ?? []).map((client) => (
              <ClientRow key={client.id} client={client} />
            ))}
            {status.isLoading ? (
              <li className="px-3.5 py-3 text-xs text-muted-foreground">Checking your CLIs…</li>
            ) : null}
          </ul>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border px-3.5 py-3">
            <p className="text-xs text-muted-foreground">
              Only agents in Runova&apos;s own tabs may connect right now.
            </p>
            <Button
              type="button"
              variant="soft"
              size="sm"
              onClick={() => save({ aiAccessClients: 'both' })}
            >
              Let other apps connect too
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
