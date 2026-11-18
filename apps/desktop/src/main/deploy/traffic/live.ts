import { randomUUID } from 'node:crypto';
import type { IStreamResult } from '@microsoft/signalr';
import type { TrafficLive } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployTrafficLiveEvent,
  DeployTrafficLiveWatchInput,
} from '../../../shared/deployTrafficTypes';
import { IPC } from '../../../shared/ipcChannels';
import { hubMessage } from '../connection/hubErrors';
import type { CoreLinks } from '../live/coreLinks';
import type { LinkFeed } from '../live/feeds';
import type { SubscriptionOwner } from '../live/subscriptions';
import { OLDER_CORE } from './service';

/**
 * Live visitors on a server's sites (E109): the core counts the last five minutes from memory and
 * sends a reading every five seconds. Each stream belongs to the window that opened it, sends to
 * that window alone and ends when the window goes away. A reading is small and comes every few
 * seconds, so it is passed on as it comes, with no batching.
 */

const REOPEN_AFTER_END_MS = 1_000;
const REOPEN_AFTER_FAILURE_MS = 5_000;
/** The core refuses a stream over its per-connection limit, and counts a closed one a moment more. */
const STREAMS_BUSY = /streams open/;
const MISSING_METHOD = /Method does not exist/i;
/** Like the site logs, two per server; the app's windows share one connection. */
const MAX_PER_SERVER = 2;

export interface TrafficLiveFeedEvents {
  next(live: TrafficLive): void;
  ended(end: { error?: string }): void;
}

export class TrafficLiveFeed implements LinkFeed<TrafficLive> {
  constructor(
    readonly siteId: string | null,
    private readonly events: TrafficLiveFeedEvents,
  ) {}

  open(hub: ICoreHub): IStreamResult<TrafficLive> {
    return hub.streamTrafficLive(this.siteId ? { siteId: this.siteId } : {});
  }

  next(live: TrafficLive): void {
    this.events.next(live);
  }

  ended(): number {
    // The core only lets go of a live stream when it restarts or drops a slow reader.
    return REOPEN_AFTER_END_MS;
  }

  failed(error: Error): number | null {
    if (STREAMS_BUSY.test(error.message)) return REOPEN_AFTER_FAILURE_MS;
    this.events.ended({
      error: MISSING_METHOD.test(error.message) ? OLDER_CORE : hubMessage(error),
    });
    return null;
  }
}

export interface TrafficLiveSubscriptionsDeps {
  links: Pick<CoreLinks, 'attachFeed'>;
  newId?: () => string;
}

interface Entry {
  ownerId: number;
  serverId: string;
  stop: () => void;
}

export class TrafficLiveSubscriptions {
  private readonly entries = new Map<string, Entry>();
  private readonly newId: () => string;

  constructor(private readonly deps: TrafficLiveSubscriptionsDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  watch(owner: SubscriptionOwner, input: DeployTrafficLiveWatchInput): string {
    const open = [...this.entries.values()].filter((entry) => entry.serverId === input.serverId);
    if (open.length >= MAX_PER_SERVER) {
      throw new Error('Two live views are already open for this server. Close one first.');
    }
    const id = this.newId();
    const send = (fields: Pick<DeployTrafficLiveEvent, 'live' | 'ended'>) => {
      const event: DeployTrafficLiveEvent = {
        subscriptionId: id,
        serverId: input.serverId,
        siteId: input.siteId,
        ...fields,
      };
      owner.send(IPC.deployTraffic.onLive, event);
    };
    const feed = new TrafficLiveFeed(input.siteId, {
      next: (live) => send({ live }),
      ended: (end) => {
        send({ ended: end });
        this.entries.get(id)?.stop();
        this.entries.delete(id);
      },
    });
    const detach = this.deps.links.attachFeed(input.serverId, feed);
    this.entries.set(id, { ownerId: owner.id, serverId: input.serverId, stop: detach });
    return id;
  }

  /** Ends one of the window's own streams. False when it has none by that id. */
  unwatch(owner: SubscriptionOwner, subscriptionId: string): boolean {
    const entry = this.entries.get(subscriptionId);
    if (!entry || entry.ownerId !== owner.id) return false;
    this.entries.delete(subscriptionId);
    entry.stop();
    return true;
  }

  /** Ends every stream of a window that closed, reloaded or crashed. */
  dropOwner(ownerId: number): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.ownerId !== ownerId) continue;
      this.entries.delete(id);
      entry.stop();
    }
  }

  count(): number {
    return this.entries.size;
  }
}
