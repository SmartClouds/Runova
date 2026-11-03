import {
  AI_ACCESS_AREA_LABELS,
  AI_ACCESS_AREAS,
  type AiAccessArea,
  type AiAccessToolInfo,
  type AiToolRisk,
} from '@shared/aiAccessTypes';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ChevronRight, Wrench } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useAiAccessSettings } from './useAiAccessSettings';

/**
 * Settings > AI access > What agents can do: every tool Runova offers, grouped by the part of the
 * app it works on, with how risky it is and whether it asks under the mode chosen above. The list
 * comes from the app itself, so it never drifts from what agents really get.
 */

const RISK: Record<AiToolRisk, { label: string; variant: 'secondary' | 'outline' | 'warning' }> = {
  read: { label: 'Read only', variant: 'outline' },
  write: { label: 'Changes', variant: 'secondary' },
  sensitive: { label: 'Sensitive', variant: 'warning' },
};

function asks(mode: string, risk: AiToolRisk): boolean {
  return mode === 'all' || (mode === 'sensitive' && risk === 'sensitive');
}

export function AiAccessToolsCard(): React.JSX.Element {
  const { values } = useAiAccessSettings();
  const [open, setOpen] = useState<AiAccessArea | null>(null);
  const tools = useQuery({
    queryKey: queryKeys.aiAccessTools,
    queryFn: () => window.runova.aiAccess.listTools(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const byArea = AI_ACCESS_AREAS.map((area) => ({
    area,
    tools: (tools.data ?? []).filter((tool: AiAccessToolInfo) => tool.area === area),
  })).filter((group) => group.tools.length > 0);

  return (
    <Card className="glass">
      <CardHeader className="flex-row items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Wrench className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle>What agents can do</CardTitle>
          <CardDescription>
            {tools.data ? `${tools.data.length} tools across ${byArea.length} areas. ` : null}
            Runs goes through by itself; Asks waits for you under the mode you picked.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-background/40">
          {byArea.map(({ area, tools: list }) => {
            const expanded = open === area;
            const label = AI_ACCESS_AREA_LABELS[area];
            const asking = list.filter((tool) => asks(values.mode, tool.risk)).length;
            return (
              <div key={area}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : area)}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/40"
                >
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 text-muted-foreground transition-transform motion-reduce:transition-none',
                      expanded && 'rotate-90',
                    )}
                  />
                  <span className="flex-1 text-sm font-medium">{label}</span>
                  {asking > 0 ? (
                    <span className="text-[11px] text-warning">{asking} ask</span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {list.length} {list.length === 1 ? 'tool' : 'tools'}
                  </span>
                </button>
                {expanded ? (
                  <ul aria-label={`${label} tools`} className="space-y-1 px-3.5 pb-3">
                    {list.map((tool) => (
                      <li
                        key={tool.name}
                        className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-accent/30"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">{tool.title}</p>
                          <p className="font-mono text-[11px] text-muted-foreground">{tool.name}</p>
                        </div>
                        <Badge variant={RISK[tool.risk].variant} className="font-normal">
                          {RISK[tool.risk].label}
                        </Badge>
                        <span
                          className={cn(
                            'w-10 pt-0.5 text-right text-[11px] font-medium',
                            asks(values.mode, tool.risk) ? 'text-warning' : 'text-success',
                          )}
                        >
                          {asks(values.mode, tool.risk) ? 'Asks' : 'Runs'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
