import type { ComposePortBinding } from '@runova/core';
import type {
  ContainerPort,
  ContainerSummary,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { describe, expect, it } from 'vitest';
import { describeHolder, findPortConflicts } from './portConflicts';

function binding(overrides: Partial<ComposePortBinding> = {}): ComposePortBinding {
  return {
    service: 'gateway',
    index: 0,
    hostIp: '127.0.0.1',
    published: '8090',
    target: 80,
    protocol: 'tcp',
    exposure: 'loopback',
    name: null,
    appProtocol: null,
    ...overrides,
  };
}

function container(
  name: string,
  ports: ContainerPort[],
  composeProject: string | null = 'other',
): ContainerSummary {
  return {
    id: `id-${name}`,
    name,
    image: 'nginx:1.29',
    imageId: 'sha256:1',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    createdAtUnixMs: 0,
    ports,
    ...(composeProject ? { composeProject } : {}),
  };
}

const port = (hostPort: number, hostIp?: string, protocol = 'tcp'): ContainerPort => ({
  privatePort: 80,
  protocol,
  hostIp,
  hostPort,
});

describe('findPortConflicts', () => {
  it('finds a host port another app already holds', () => {
    const conflicts = findPortConflicts(
      [binding()],
      [container('blog-web-1', [port(8090, '127.0.0.1')], 'blog')],
      'runova-website',
    );
    expect(conflicts).toEqual([
      {
        service: 'gateway',
        index: 0,
        target: 80,
        port: 8090,
        protocol: 'tcp',
        holders: [{ containerId: 'id-blog-web-1', containerName: 'blog-web-1', project: 'blog' }],
      },
    ]);
  });

  it('ignores the app own containers, which the deploy replaces', () => {
    const conflicts = findPortConflicts(
      [binding()],
      [container('site-gateway-1', [port(8090, '127.0.0.1')], 'runova-website')],
      'runova-website',
    );
    expect(conflicts).toEqual([]);
  });

  it('treats every address as clashing with any address, and lists a container once', () => {
    const holder = container('proxy', [port(8090, '0.0.0.0'), port(8090, '::')], null);
    const conflicts = findPortConflicts([binding()], [holder], 'app');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].holders).toEqual([
      { containerId: 'id-proxy', containerName: 'proxy', project: null },
    ]);
    expect(findPortConflicts([binding({ hostIp: null })], [holder], 'app')).toHaveLength(1);
    expect(
      findPortConflicts(
        [binding({ hostIp: null })],
        [container('x', [port(8090, '10.0.0.5')])],
        'app',
      ),
    ).toHaveLength(1);
  });

  it('lets different addresses, ports and protocols share', () => {
    const containers = [
      container('a', [port(8090, '10.0.0.5')]),
      container('b', [port(8091, '127.0.0.1')]),
      container('c', [port(8090, '127.0.0.1', 'udp')]),
      container('d', []),
    ];
    expect(findPortConflicts([binding()], containers, 'app')).toEqual([]);
  });

  it('skips ports Docker picks itself', () => {
    const holder = container('a', [port(8090)]);
    expect(findPortConflicts([binding({ published: null })], [holder], 'app')).toEqual([]);
    expect(findPortConflicts([binding({ published: '8090-8095' })], [holder], 'app')).toEqual([]);
  });

  it('names the app a container belongs to', () => {
    expect(describeHolder({ containerId: '1', containerName: 'blog-web-1', project: 'blog' })).toBe(
      'blog-web-1 (app blog)',
    );
    expect(describeHolder({ containerId: '1', containerName: 'proxy', project: null })).toBe(
      'proxy',
    );
  });
});
