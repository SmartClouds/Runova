import { describe, expect, it } from 'vitest';
import {
  ago,
  emptyNodeForm,
  fromNode,
  lagLabel,
  type MonitoringNode,
  nodeBody,
  nodeEnv,
  nodeTone,
  parseAddresses,
  summarize,
  until,
} from '../src/lib/admin/monitoringNodes';

const NOW = Date.parse('2026-11-07T12:00:00Z');

function node(overrides: Partial<MonitoringNode> = {}): MonitoringNode {
  return {
    id: 1,
    name: 'eu-1',
    region: 'eu-central',
    capacity: 100,
    status: 'online',
    draining: false,
    softwareVersion: '3.3.0',
    remoteAddress: '203.0.113.7',
    enrolledAt: '2026-11-06T12:00:00Z',
    connectedAt: '2026-11-07T11:00:00Z',
    lastSeenAt: '2026-11-07T11:59:55Z',
    monitors: 12,
    checksLastMinute: 240,
    queuedResults: 0,
    lagMs: 0,
    allowedAddresses: [],
    enrollmentTokenExpiresAt: null,
    certificateExpiresAt: '2026-11-13T12:00:00Z',
    createdAt: '2026-11-06T11:00:00Z',
    revokedAt: null,
    version: '1',
    ...overrides,
  };
}

describe('monitoring nodes', () => {
  it('shows draining as its own state only while a node is online', () => {
    expect(nodeTone(node())).toBe('online');
    expect(nodeTone(node({ draining: true }))).toBe('draining');
    expect(nodeTone(node({ draining: true, status: 'offline' }))).toBe('offline');
    expect(nodeTone(node({ status: 'pending' }))).toBe('pending');
  });

  it('says how long ago and how long until in plain words', () => {
    expect(ago(null, NOW)).toBe('never');
    expect(ago('2026-11-07T11:59:58Z', NOW)).toBe('just now');
    expect(ago('2026-11-07T11:59:48Z', NOW)).toBe('12 s ago');
    expect(ago('2026-11-07T11:56:00Z', NOW)).toBe('4 min ago');
    expect(ago('2026-11-07T09:00:00Z', NOW)).toBe('3 h ago');
    expect(ago('2026-11-04T12:00:00Z', NOW)).toBe('3 d ago');
    expect(until('2026-11-13T12:00:00Z', NOW)).toBe('in 6 days');
    expect(until('2026-11-07T17:00:00Z', NOW)).toBe('in 5 h');
    expect(until('2026-11-07T12:20:00Z', NOW)).toBe('in 20 min');
    expect(until('2026-11-07T11:00:00Z', NOW)).toBe('ran out');
    expect(until(null, NOW)).toBe('none');
  });

  it('says lag as on time or seconds late', () => {
    expect(lagLabel(0)).toBe('on time');
    expect(lagLabel(2400)).toBe('2.4 s late');
    expect(lagLabel(15_000)).toBe('15 s late');
  });

  it('counts the nodes by state and adds up only the online ones', () => {
    const counts = summarize([
      node(),
      node({ id: 2, draining: true, monitors: 0, checksLastMinute: 0 }),
      node({ id: 3, status: 'offline', monitors: 5, checksLastMinute: 99 }),
      node({ id: 4, status: 'pending', monitors: 0 }),
    ]);

    expect(counts).toMatchObject({
      online: 1,
      draining: 1,
      offline: 1,
      pending: 1,
      revoked: 0,
      monitors: 12,
      checksPerMinute: 240,
    });
  });

  it('writes the env a node needs', () => {
    expect(nodeEnv({ token: 'rnn_abc', apiUrl: 'https://runovahq.com' })).toBe(
      'NODE_ENROLLMENT_TOKEN=rnn_abc\nRUNOVA_API_URL=https://runovahq.com\n',
    );
  });

  it('reads addresses from lines and commas', () => {
    expect(parseAddresses(' 203.0.113.7 \n\n198.51.100.0/24, 2001:db8::1 ')).toEqual([
      '203.0.113.7',
      '198.51.100.0/24',
      '2001:db8::1',
    ]);
  });

  it('builds the write body and keeps a bad capacity as typed', () => {
    expect(
      nodeBody({
        ...emptyNodeForm,
        name: ' eu-1 ',
        region: 'EU-Central',
        capacity: '200',
        allowedAddresses: '203.0.113.7',
      }),
    ).toEqual({
      name: 'eu-1',
      region: 'eu-central',
      capacity: 200,
      allowedAddresses: ['203.0.113.7'],
    });
    expect(nodeBody({ ...emptyNodeForm, name: 'x', region: 'eu', capacity: 'lots' }).capacity).toBe(
      'lots',
    );
    expect(nodeBody({ ...emptyNodeForm, name: 'x', region: 'eu', capacity: '' }).capacity).toBe('');
  });

  it('fills the edit form from a node', () => {
    expect(fromNode(node({ allowedAddresses: ['203.0.113.7/32', '198.51.100.0/24'] }))).toEqual({
      name: 'eu-1',
      region: 'eu-central',
      capacity: '100',
      allowedAddresses: '203.0.113.7/32\n198.51.100.0/24',
    });
  });
});
