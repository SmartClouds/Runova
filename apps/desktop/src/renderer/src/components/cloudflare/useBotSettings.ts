import type {
  CloudflareAiBotsProtection,
  CloudflareBotChange,
  CloudflareBotSettings,
  CloudflareZone,
} from '@shared/cloudflareTypes';
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { botChangeDone } from '@/lib/cloudflare/labels';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Where each zone blocked AI bots before they were switched off, so the header switch turns them
 * back on the way they were. It lasts as long as the window does.
 */
const blockingBeforeOff = new Map<string, Exclude<CloudflareAiBotsProtection, 'disabled'>>();

/** Where to block AI bots when the header switch turns them on: as before, else everywhere. */
export function aiBotsWhenOn(zoneId: string): Exclude<CloudflareAiBotsProtection, 'disabled'> {
  return blockingBeforeOff.get(zoneId) ?? 'block';
}

export interface BotSettings {
  query: UseQueryResult<CloudflareBotSettings>;
  /** The load error in words, once there is one. */
  loadError: string | null;
  /** The setting being written, so only its control waits. */
  saving: CloudflareBotChange['setting'] | null;
  /** Writes one setting, keeps Cloudflare's answer and says how it went. */
  change: (next: CloudflareBotChange) => Promise<void>;
}

/**
 * A zone's bot settings, shared by the header's AI bots switch and the Security tab's card. They
 * come from Bot Management, which needs its own permission, so they load apart from the zone
 * settings: a token without it loses only these controls.
 */
export function useBotSettings(zone: CloudflareZone): BotSettings {
  const queryClient = useQueryClient();
  const key = queryKeys.cloudflareBots(zone.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => window.runova.cloudflare.botSettings(zone.id),
  });
  const loadError = useCloudflareError(query.error);
  const [saving, setSaving] = useState<CloudflareBotChange['setting'] | null>(null);

  const aiBots = query.data?.aiBots;
  useEffect(() => {
    if (aiBots && aiBots !== 'disabled') blockingBeforeOff.set(zone.id, aiBots);
  }, [aiBots, zone.id]);

  async function change(next: CloudflareBotChange): Promise<void> {
    setSaving(next.setting);
    try {
      queryClient.setQueryData(key, await window.runova.cloudflare.changeBotSetting(zone.id, next));
      toast.success(botChangeDone(next));
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setSaving(null);
    }
  }

  return { query, loadError, saving, change };
}
