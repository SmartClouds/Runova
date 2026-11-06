/** `MonitoringNodeDto` (E54). */
export interface MonitoringNode {
  id: number;
  name: string;
  region: string;
  capacity: number;
  status: NodeStatus;
  draining: boolean;
  softwareVersion: string | null;
  remoteAddress: string | null;
  enrolledAt: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  monitors: number;
  checksLastMinute: number;
  queuedResults: number;
  lagMs: number;
  allowedAddresses: string[];
  enrollmentTokenExpiresAt: string | null;
  certificateExpiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  version: string;
}

export type NodeStatus = 'pending' | 'online' | 'offline' | 'revoked';

export interface EnrollmentToken {
  token: string;
  expiresAt: string;
  apiUrl: string;
}

export interface CreatedNode {
  node: MonitoringNode;
  enrollment: EnrollmentToken;
}

/** What a node card shows: its status, with draining as its own state while it is online. */
export type NodeTone = 'online' | 'draining' | 'offline' | 'pending' | 'revoked';

export function nodeTone(node: Pick<MonitoringNode, 'status' | 'draining'>): NodeTone {
  if (node.status === 'online' && node.draining) return 'draining';
  return node.status;
}

export const TONE_LABELS: Record<NodeTone, string> = {
  online: 'Online',
  draining: 'Draining',
  offline: 'Offline',
  pending: 'Waiting to enroll',
  revoked: 'Revoked',
};

/** "just now", "12 s ago", "4 min ago", "3 h ago", "2 d ago"; "never" for none. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "in 6 days", "in 5 h", "ran out": when a certificate or token ends. */
export function until(iso: string | null, now = Date.now()): string {
  if (!iso) return 'none';
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds <= 0) return 'ran out';
  const hours = Math.floor(seconds / 3600);
  if (hours < 1) return `in ${Math.max(1, Math.round(seconds / 60))} min`;
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.floor(hours / 24)} days`;
}

/** Lag in a word a person reads: "on time" under a second, else seconds. */
export function lagLabel(ms: number): string {
  if (ms < 1000) return 'on time';
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s late`;
}

/** The counts the page header shows. */
export function summarize(nodes: readonly MonitoringNode[]): Record<NodeTone, number> & {
  monitors: number;
  checksPerMinute: number;
} {
  const counts = {
    online: 0,
    draining: 0,
    offline: 0,
    pending: 0,
    revoked: 0,
    monitors: 0,
    checksPerMinute: 0,
  };
  for (const node of nodes) {
    counts[nodeTone(node)] += 1;
    if (node.status === 'online') {
      counts.monitors += node.monitors;
      counts.checksPerMinute += node.checksLastMinute;
    }
  }
  return counts;
}

/** The `.env` a node needs next to its compose file. */
export function nodeEnv(enrollment: Pick<EnrollmentToken, 'token' | 'apiUrl'>): string {
  return `NODE_ENROLLMENT_TOKEN=${enrollment.token}\nRUNOVA_API_URL=${enrollment.apiUrl}\n`;
}

export interface NodeForm {
  name: string;
  region: string;
  capacity: string;
  allowedAddresses: string;
}

export const emptyNodeForm: NodeForm = {
  name: '',
  region: '',
  capacity: '100',
  allowedAddresses: '',
};

export function fromNode(node: MonitoringNode): NodeForm {
  return {
    name: node.name,
    region: node.region,
    capacity: String(node.capacity),
    allowedAddresses: node.allowedAddresses.join('\n'),
  };
}

/** One address or range per line or comma, blanks dropped. */
export function parseAddresses(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The write body. A capacity that is not a whole number goes as the typed text, so the API names
 * the field instead of the page sending NaN, which JSON writes as null.
 */
export function nodeBody(form: NodeForm): Record<string, unknown> {
  const capacity = Number(form.capacity);
  return {
    name: form.name.trim(),
    region: form.region.trim().toLowerCase(),
    capacity: Number.isInteger(capacity) && form.capacity.trim() !== '' ? capacity : form.capacity,
    allowedAddresses: parseAddresses(form.allowedAddresses),
  };
}
