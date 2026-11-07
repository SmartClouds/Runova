import type { NetworkInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { describe, expect, it } from 'vitest';
import { describeNetwork, joinableNetworks, networksOf, withServiceNetworks } from './networks';

function network(name: string, extra: Partial<NetworkInfo> = {}): NetworkInfo {
  return {
    id: `id-${name}`,
    name,
    driver: 'bridge',
    scope: 'local',
    internal: false,
    builtIn: false,
    subnets: [],
    containers: 0,
    ...extra,
  };
}

const SERVER = [
  network('bridge', { builtIn: true }),
  network('host', { builtIn: true, driver: 'host' }),
  network('none', { builtIn: true, driver: 'null' }),
  network('shop_default', { composeProject: 'shop', containers: 2 }),
  network('ollama_default', { composeProject: 'ollama', containers: 1 }),
  network('monitoring_default', { composeProject: 'monitoring', containers: 3 }),
  network('shared', { containers: 0 }),
];

describe('joinableNetworks', () => {
  it("leaves out Docker's own networks, the app's own ones and those already joined", () => {
    const names = joinableNetworks(SERVER, 'shop', ['monitoring_default']).map((n) => n.name);
    expect(names).toEqual(['ollama_default', 'shared']);
  });

  it('lists the networks of other apps first, then the ones made by hand, by name', () => {
    const names = joinableNetworks(SERVER, 'blog', []).map((n) => n.name);
    expect(names).toEqual(['monitoring_default', 'ollama_default', 'shop_default', 'shared']);
  });
});

describe('describeNetwork', () => {
  it('names the app a network belongs to and how many containers are on it', () => {
    expect(
      describeNetwork(network('ollama_default', { composeProject: 'ollama', containers: 1 })),
    ).toBe('App ollama · 1 container');
    expect(describeNetwork(network('shared', { containers: 4 }))).toBe('4 containers');
    expect(describeNetwork(network('quiet', { internal: true }))).toBe(
      'No containers · internal only',
    );
  });
});

describe('networksOf', () => {
  it("reads one service's joined networks, none when the revision has none", () => {
    const entries = [{ service: 'web', networks: ['ollama_default'] }];
    expect(networksOf(entries, 'web')).toEqual(['ollama_default']);
    expect(networksOf(entries, 'db')).toEqual([]);
    expect(networksOf(undefined, 'web')).toEqual([]);
  });
});

describe('withServiceNetworks', () => {
  const entries = [
    { service: 'web', networks: ['ollama_default'] },
    { service: 'db', networks: ['shared'] },
  ];

  it('replaces one service and keeps the others as they are', () => {
    expect(withServiceNetworks(entries, 'web', ['ollama_default', 'monitoring_default'])).toEqual([
      { service: 'web', networks: ['ollama_default', 'monitoring_default'] },
      { service: 'db', networks: ['shared'] },
    ]);
  });

  it('adds a service that joined nothing before', () => {
    expect(withServiceNetworks([], 'web', ['shared'])).toEqual([
      { service: 'web', networks: ['shared'] },
    ]);
  });

  it('drops a service once it joins nothing, and lists each network once', () => {
    expect(withServiceNetworks(entries, 'db', [])).toEqual([
      { service: 'web', networks: ['ollama_default'] },
    ]);
    expect(withServiceNetworks([], 'web', ['shared', 'shared'])).toEqual([
      { service: 'web', networks: ['shared'] },
    ]);
  });
});
