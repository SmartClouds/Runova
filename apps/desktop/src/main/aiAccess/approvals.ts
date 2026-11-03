import { randomUUID } from 'node:crypto';
import type { AiAccessApproval, AiApprovalDecision } from '../../shared/aiAccessTypes';

/**
 * The approvals waiting on the user. The window lists the ones it should ask about; the CLI
 * answers the ones it asked about through the bridge. Each is answered once, and one nobody
 * answers in time counts as timed out, which the server treats as a no.
 */

export type ApprovalChannel = 'modal' | 'cli';
export type ApprovalOutcome = AiApprovalDecision | 'timeout';
export type ApprovalAnswerer = { channel: 'modal' } | { channel: 'cli'; connectionId: string };

export interface ApprovalRequest extends Omit<AiAccessApproval, 'id' | 'createdAt' | 'expiresAt'> {
  /** The bridge process that asked, so "allow for this session" covers that session only. */
  connectionId: string;
  channel: ApprovalChannel;
  /** What the server needs to run the call once it is allowed. Never sent to the window. */
  payload: unknown;
}

interface Pending {
  approval: AiAccessApproval;
  request: ApprovalRequest;
  settle: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalBroker {
  request(request: ApprovalRequest): { id: string; decision: Promise<ApprovalOutcome> };
  /**
   * Answers an approval. The window may answer only what it was shown, and a bridge only what it
   * asked itself. Returns what was asked, or null when it is unknown, already answered or not
   * this answerer's to answer.
   */
  decide(id: string, decision: AiApprovalDecision, by: ApprovalAnswerer): ApprovalRequest | null;
  listForWindow(): AiAccessApproval[];
  isGranted(connectionId: string, tool: string): boolean;
  /** Forgets every session grant and denies everything waiting, for when access is turned off. */
  reset(): void;
}

export function createApprovalBroker({
  timeoutMs,
  onChange,
}: {
  timeoutMs: number;
  onChange?: () => void;
}): ApprovalBroker {
  const pending = new Map<string, Pending>();
  const grants = new Map<string, Set<string>>();

  const settle = (id: string, outcome: ApprovalOutcome): Pending | null => {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.settle(outcome);
    if (entry.request.channel === 'modal') onChange?.();
    return entry;
  };

  return {
    request(request) {
      const id = randomUUID();
      const createdAt = Date.now();
      const { connectionId: _c, channel: _ch, payload: _p, ...shown } = request;
      const approval: AiAccessApproval = {
        ...shown,
        id,
        createdAt,
        expiresAt: createdAt + timeoutMs,
      };
      let resolve!: (outcome: ApprovalOutcome) => void;
      const decision = new Promise<ApprovalOutcome>((done) => {
        resolve = done;
      });
      const timer = setTimeout(() => settle(id, 'timeout'), timeoutMs);
      timer.unref?.();
      pending.set(id, { approval, request, settle: resolve, timer });
      if (request.channel === 'modal') onChange?.();
      return { id, decision };
    },

    decide(id, decision, by) {
      const waiting = pending.get(id);
      if (!waiting || waiting.request.channel !== by.channel) return null;
      if (by.channel === 'cli' && waiting.request.connectionId !== by.connectionId) return null;
      const entry = settle(id, decision);
      if (!entry) return null;
      if (decision === 'allow_session') {
        const tools = grants.get(entry.request.connectionId) ?? new Set<string>();
        tools.add(entry.request.tool);
        grants.set(entry.request.connectionId, tools);
      }
      return entry.request;
    },

    listForWindow() {
      return [...pending.values()]
        .filter((entry) => entry.request.channel === 'modal')
        .map((entry) => entry.approval);
    },

    isGranted(connectionId, tool) {
      return grants.get(connectionId)?.has(tool) ?? false;
    },

    reset() {
      grants.clear();
      for (const id of [...pending.keys()]) settle(id, 'deny');
    },
  };
}
