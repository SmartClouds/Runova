import { describe, expect, it } from 'vitest';
import type { ServerNotification } from '../../shared/dependencyAlerts';
import { inboxEntry, isMonitorMessage } from './inbox';

function message(overrides: Partial<ServerNotification> = {}): ServerNotification {
  return {
    id: 7,
    kind: 'dependency-updates',
    title: '2 package updates for Api',
    body: 'express 4.18.0 to 5.0.0',
    severity: null,
    scopeId: 5,
    itemId: 'p1',
    inventoryId: 3,
    createdAt: '2026-11-07T09:00:00Z',
    readAt: null,
    ...overrides,
  };
}

describe('inboxEntry', () => {
  it('leads a dependency alert to the project Packages tab', () => {
    expect(inboxEntry(message(), { id: 'p1', name: 'Api' })).toMatchObject({
      id: 'dependency:7',
      kind: 'dependency-updates',
      route: '/projects/p1?tab=packages',
    });
  });

  it('leads an online monitor going down or back up to the monitor (E56)', () => {
    const monitor = { targetId: 't-api', projectId: 'p1', projectName: 'Storefront' };

    const down = inboxEntry(
      message({ kind: 'monitor-down', title: 'API in Storefront is down', itemId: 't-api' }),
      null,
      monitor,
    );
    const up = inboxEntry(
      message({
        id: 8,
        kind: 'monitor-recovered',
        itemId: 't-api',
        readAt: '2026-11-07T09:30:00Z',
      }),
      null,
      monitor,
    );

    expect(down).toMatchObject({
      id: 'monitor:7',
      kind: 'health-failure',
      title: 'API in Storefront is down',
      projectId: 'p1',
      projectName: 'Storefront',
      route: '/monitoring?target=t-api',
      read: false,
    });
    expect(up).toMatchObject({ id: 'monitor:8', kind: 'health-recovered', read: true });
  });

  it('leads a plan notice, or a monitor this computer does not have, to the Monitoring page', () => {
    expect(inboxEntry(message({ kind: 'monitor-plan', itemId: null }), null).route).toBe(
      '/monitoring',
    );
    expect(inboxEntry(message({ kind: 'monitor-down', itemId: 'gone' }), null)).toMatchObject({
      projectName: 'Monitoring',
      route: '/monitoring',
    });
  });

  it('knows which messages are about online monitors', () => {
    expect(isMonitorMessage(message({ kind: 'monitor-down' }))).toBe(true);
    expect(isMonitorMessage(message())).toBe(false);
  });
});
