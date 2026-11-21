import type { ComposePortBinding } from '@runova/core';
import type {
  ContainerPort,
  ContainerSummary,
  ListeningSocketInfo,
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
        holders: [
          {
            kind: 'container',
            containerId: 'id-blog-web-1',
            containerName: 'blog-web-1',
            project: 'blog',
          },
        ],
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
      { kind: 'container', containerId: 'id-proxy', containerName: 'proxy', project: null },
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

  it('names the app a container belongs to, and a program by its name and pid', () => {
    expect(
      describeHolder({
        kind: 'container',
        containerId: '1',
        containerName: 'blog-web-1',
        project: 'blog',
      }),
    ).toBe('blog-web-1 (app blog)');
    expect(
      describeHolder({
        kind: 'container',
        containerId: '1',
        containerName: 'proxy',
        project: null,
      }),
    ).toBe('proxy');
    expect(
      describeHolder({
        kind: 'container',
        containerId: '1',
        containerName: 'agent',
        project: null,
        hostNetwork: true,
      }),
    ).toBe('agent (host network)');
    expect(describeHolder({ kind: 'process', process: 'node', pid: 4100 })).toBe(
      'the program node (pid 4100)',
    );
    expect(describeHolder({ kind: 'process', process: null, pid: null })).toBe(
      'a program on the server',
    );
    expect(describeHolder({ kind: 'process', process: 'docker-proxy', pid: 7 })).toBe(
      "docker-proxy (pid 7), for a container this server's Docker does not list",
    );
  });
});

const HOST_ID = 'ab12'.repeat(16);

function socket(overrides: Partial<ListeningSocketInfo> = {}): ListeningSocketInfo {
  return {
    protocol: 'tcp',
    address: '*',
    port: 8090,
    scope: 'public',
    firewall: 'closed',
    process: 'node',
    pid: 4100,
    ...overrides,
  };
}

describe('findPortConflicts with what listens on the server', () => {
  it('names a container on the host network through its socket', () => {
    const agent = { ...container('agent', [], 'monitor'), id: HOST_ID };
    const conflicts = findPortConflicts([binding()], [agent], 'app', [
      socket({ containerId: HOST_ID }),
    ]);
    expect(conflicts[0].holders).toEqual([
      {
        kind: 'container',
        containerId: HOST_ID,
        containerName: 'agent',
        project: 'monitor',
        hostNetwork: true,
      },
    ]);
  });

  it('matches a short container id, and falls back to the id when Docker does not list it', () => {
    const agent = { ...container('agent', [], 'monitor'), id: HOST_ID.slice(0, 12) };
    expect(
      findPortConflicts([binding()], [agent], 'app', [socket({ containerId: HOST_ID })])[0]
        .holders[0],
    ).toMatchObject({ containerName: 'agent', project: 'monitor' });
    expect(
      findPortConflicts([binding()], [], 'app', [socket({ containerId: HOST_ID })])[0].holders[0],
    ).toMatchObject({ containerName: HOST_ID.slice(0, 12), project: null, hostNetwork: true });
  });

  it('skips the app own containers on the host network', () => {
    const own = { ...container('app-web-1', [], 'app'), id: HOST_ID };
    expect(
      findPortConflicts([binding()], [own], 'app', [socket({ containerId: HOST_ID })]),
    ).toEqual([]);
  });

  it('names a program that holds the port, once for each of its sockets', () => {
    const conflicts = findPortConflicts([binding()], [], 'app', [
      socket({ process: 'node', pid: 4100 }),
      socket({ address: '[::]', process: 'node', pid: 4100 }),
    ]);
    expect(conflicts[0].holders).toEqual([{ kind: 'process', process: 'node', pid: 4100 }]);
  });

  it('counts docker-proxy only for a port no listed container publishes', () => {
    const blog = container('blog-web-1', [port(8090, '0.0.0.0')], 'blog');
    const proxy = socket({ address: '0.0.0.0', process: 'docker-proxy', pid: 7 });
    expect(findPortConflicts([binding()], [blog], 'app', [proxy])[0].holders).toEqual([
      {
        kind: 'container',
        containerId: 'id-blog-web-1',
        containerName: 'blog-web-1',
        project: 'blog',
      },
    ]);
    const own = container('app-web-1', [port(8090, '127.0.0.1')], 'app');
    expect(findPortConflicts([binding()], [own], 'app', [proxy])).toEqual([]);
    expect(findPortConflicts([binding()], [], 'app', [proxy])[0].holders).toEqual([
      { kind: 'process', process: 'docker-proxy', pid: 7 },
    ]);
  });

  it('reads the addresses ss writes', () => {
    for (const address of ['*', '[::]', '0.0.0.0', '127.0.0.1']) {
      expect(findPortConflicts([binding()], [], 'app', [socket({ address })])).toHaveLength(1);
    }
    for (const address of ['[::1]', '127.0.0.53%lo', '10.0.0.5']) {
      expect(findPortConflicts([binding()], [], 'app', [socket({ address })])).toEqual([]);
    }
    expect(
      findPortConflicts([binding()], [], 'app', [
        socket({ protocol: 'udp' }),
        socket({ port: 8091 }),
      ]),
    ).toEqual([]);
  });
});
