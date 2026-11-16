import { describe, expect, it } from 'vitest';
import {
  parseCleanLine,
  parseGithubUrl,
  parseHumanSize,
  parseScanOutput,
  parseScheduleLine,
  scanStepOf,
} from './scanParse';

const T = '\t';
const line = (...fields: string[]): string => fields.join(T);
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const RUNNER_JSON = JSON.stringify({
  agentId: 42,
  agentName: 'build-01',
  poolId: 1,
  serverUrl: 'https://pipelines.actions.githubusercontent.com/abc',
  gitHubUrl: 'https://github.com/acme/web',
  workFolder: '_work',
});

const LINUX = [
  line('os', 'Linux'),
  line('home', '/home/ci'),
  line('step', 'runners'),
  line('runner', '/home/ci/actions-runner/build-01'),
  line('runner', '/opt/old-runner'),
  // A BOM in front, as the runner writes the file on some versions.
  line('runnerfile', '/home/ci/actions-runner/build-01'),
  line('runnerjson', '/home/ci/actions-runner/build-01', b64(`\uFEFF${RUNNER_JSON}`)),
  line('configured', '/home/ci/actions-runner/build-01'),
  line('configured', '/opt/old-runner'),
  line('service', '/home/ci/actions-runner/build-01', 'actions.runner.acme-web.build-01.service'),
  line('busy', '/home/ci/actions-runner/build-01'),
  line(
    'size',
    '/home/ci/actions-runner/build-01',
    'checkout',
    '204800',
    '/home/ci/actions-runner/build-01/_work/web',
  ),
  line(
    'size',
    '/home/ci/actions-runner/build-01',
    'temp',
    '1024',
    '/home/ci/actions-runner/build-01/_work/_temp',
  ),
  line(
    'size',
    '/home/ci/actions-runner/build-01',
    'tool',
    '50000',
    '/home/ci/actions-runner/build-01/_work/_tool/node/18.20.4',
  ),
  line(
    'size',
    '/home/ci/actions-runner/build-01',
    'diag',
    '300',
    '/home/ci/actions-runner/build-01/_diag',
  ),
  line(
    'size',
    '/home/ci/actions-runner/build-01',
    'oldver',
    '90000',
    '/home/ci/actions-runner/build-01/bin.2.319.1',
  ),
  line('size', '/home/ci/actions-runner/build-01', 'weird', '1', '/x'),
  line('step', 'docker'),
  line('docker', 'ok', 'sudo'),
  line(
    'dockerdf',
    '{"Active":"2","Reclaimable":"1.2GB (35%)","Size":"3.4GB","TotalCount":"5","Type":"Images"}',
  ),
  line(
    'dockerdf',
    '{"Active":"1","Reclaimable":"10.5MB (90%)","Size":"11.6MB","TotalCount":"3","Type":"Containers"}',
  ),
  line('dockerdf', 'not json'),
  line('dockerdangling', '120MB'),
  line('dockerdangling', '1.5GB'),
  line('step', 'caches'),
  line('cache', 'npm', '/home/ci', '2048', '/home/ci/.npm/_cacache'),
  line('cache', 'nope', '/home/ci', '1', '/home/ci/.nope'),
  line('tool', 'npm'),
  line('tool', 'go'),
  line('disk', '/dev/sda1 102400000 61440000 40960000 61% /'),
  line('step', 'schedule'),
  line('sched', 'installed', 'cron'),
  line('schedconfig', '{"frequency":"weekly"}'),
  line('schedlog', '2026-11-15T03:00:01Z', '2048', 'ok'),
  'some stray output a tool printed',
  '',
].join('\n');

describe('parseScanOutput', () => {
  const facts = parseScanOutput(LINUX);

  it('reads the OS and the login home', () => {
    expect(facts.os).toBe('linux');
    expect(facts.home).toBe('/home/ci');
  });

  it('collects one entry per runner folder with what the scan said about it', () => {
    expect(facts.runners.map((runner) => runner.dir)).toEqual([
      '/home/ci/actions-runner/build-01',
      '/opt/old-runner',
    ]);
    const [live, old] = facts.runners;
    expect(live).toMatchObject({
      hasRunnerFile: true,
      configured: true,
      service: 'actions.runner.acme-web.build-01.service',
      busy: true,
      registration: { agentId: 42, name: 'build-01', url: 'https://github.com/acme/web' },
    });
    expect(old).toMatchObject({
      hasRunnerFile: false,
      configured: true,
      service: null,
      busy: false,
      registration: null,
    });
  });

  it('keeps sizes in bytes and drops kinds it does not know', () => {
    const [live] = facts.runners;
    expect(live.sizes).toEqual([
      {
        kind: 'checkout',
        bytes: 204800 * 1024,
        path: '/home/ci/actions-runner/build-01/_work/web',
      },
      { kind: 'temp', bytes: 1024 * 1024, path: '/home/ci/actions-runner/build-01/_work/_temp' },
      {
        kind: 'tool',
        bytes: 50000 * 1024,
        path: '/home/ci/actions-runner/build-01/_work/_tool/node/18.20.4',
      },
      { kind: 'diag', bytes: 300 * 1024, path: '/home/ci/actions-runner/build-01/_diag' },
      { kind: 'oldver', bytes: 90000 * 1024, path: '/home/ci/actions-runner/build-01/bin.2.319.1' },
    ]);
  });

  it('reads Docker, its sudo and its reclaimable figures', () => {
    expect(facts.docker.state).toBe('ok');
    expect(facts.docker.viaSudo).toBe(true);
    expect(facts.docker.rows).toEqual([
      { type: 'Images', reclaimableBytes: 1.2e9, totalCount: 5, active: 2 },
      { type: 'Containers', reclaimableBytes: 10.5e6, totalCount: 3, active: 1 },
    ]);
    expect(facts.docker.danglingBytes).toBe(120e6 + 1.5e9);
  });

  it('keeps caches from the catalog only, and the tools on PATH', () => {
    expect(facts.caches).toEqual([
      { id: 'npm', home: '/home/ci', bytes: 2048 * 1024, path: '/home/ci/.npm/_cacache' },
    ]);
    expect([...facts.tools].sort()).toEqual(['go', 'npm']);
  });

  it('reads the disk the runners live on', () => {
    expect(facts.disk).toEqual({
      usedBytes: 61440000 * 1024,
      totalBytes: (61440000 + 40960000) * 1024,
      mount: '/',
    });
  });

  it('reads the schedule back', () => {
    expect(facts.schedule).toEqual({
      installed: true,
      job: 'cron',
      config: '{"frequency":"weekly"}',
      lastLog: '2026-11-15T03:00:01Z\t2048\tok',
      noCron: false,
    });
  });
});

describe('parseScanOutput on other systems', () => {
  it('reads a Windows disk line and the busy-but-cannot-tell flag', () => {
    const facts = parseScanOutput(
      [
        line('os', 'Windows'),
        line('home', 'C:\\Users\\ci'),
        line('diskwin', 'C:', '500000000000', '100000000000'),
        line('busyunknown'),
        line('docker', 'missing'),
        line('sched', 'installed', 'task'),
      ].join('\r\n'),
    );
    expect(facts.os).toBe('windows');
    expect(facts.disk).toEqual({ usedBytes: 4e11, totalBytes: 5e11, mount: 'C:' });
    expect(facts.busyUnknown).toBe(true);
    expect(facts.docker.state).toBe('missing');
    expect(facts.schedule.job).toBe('task');
  });

  it('reads macOS and a Linux machine without cron', () => {
    expect(parseScanOutput(line('os', 'Darwin')).os).toBe('macos');
    expect(parseScanOutput([line('os', 'Linux'), 'nocron'].join('\n')).schedule.noCron).toBe(true);
  });

  it('says nothing about an OS it does not know', () => {
    expect(parseScanOutput('hello').os).toBeNull();
  });
});

describe('parseHumanSize', () => {
  it('reads the decimal units Docker prints', () => {
    expect(parseHumanSize('0B')).toBe(0);
    expect(parseHumanSize('1.03kB')).toBe(1030);
    expect(parseHumanSize('512.5MB')).toBe(512.5e6);
    expect(parseHumanSize('2GB')).toBe(2e9);
    expect(parseHumanSize('1.2GB (35%)')).toBe(1.2e9);
    expect(parseHumanSize('1.1TB')).toBe(1.1e12);
  });

  it('is null for text that is not a size', () => {
    expect(parseHumanSize('')).toBeNull();
    expect(parseHumanSize('lots')).toBeNull();
  });
});

describe('parseGithubUrl', () => {
  it('tells a repo from an org', () => {
    expect(parseGithubUrl('https://github.com/acme/web')).toEqual({
      kind: 'repo',
      name: 'acme/web',
    });
    expect(parseGithubUrl('https://github.com/acme/')).toEqual({ kind: 'org', name: 'acme' });
  });

  it('is null for an enterprise or another host, which Runova cannot check', () => {
    expect(parseGithubUrl('https://github.com/enterprises/big')).toBeNull();
    expect(parseGithubUrl('https://ghe.example.com/acme/web')).toBeNull();
    expect(parseGithubUrl('nonsense')).toBeNull();
  });
});

describe('scanStepOf', () => {
  it('reads the step markers the scan prints as it goes', () => {
    expect(scanStepOf('step\tdocker')).toBe('docker');
    expect(scanStepOf('step\tnope')).toBeNull();
    expect(scanStepOf('runner\t/x')).toBeNull();
  });
});

describe('parseCleanLine', () => {
  it('reads the marker lines a cleanup prints per item', () => {
    expect(parseCleanLine('@@done\tr0-temp\t2048')).toEqual({
      id: 'r0-temp',
      status: 'done',
      freedBytes: 2048 * 1024,
    });
    expect(parseCleanLine('@@donehuman\tdocker-build\t1.5GB')).toEqual({
      id: 'docker-build',
      status: 'done',
      freedBytes: 1.5e9,
    });
    expect(parseCleanLine('@@fail\tr0-checkouts\t10\tPermission denied')).toEqual({
      id: 'r0-checkouts',
      status: 'failed',
      freedBytes: 10 * 1024,
      error: 'Permission denied',
    });
    expect(parseCleanLine('@@skip\tr0-checkouts\tA job started on this runner')).toEqual({
      id: 'r0-checkouts',
      status: 'skipped',
      freedBytes: 0,
      error: 'A job started on this runner',
    });
  });

  it('never reports a negative amount, and ignores other output', () => {
    expect(parseCleanLine('@@done\tx\t-5')?.freedBytes).toBe(0);
    expect(parseCleanLine('@@donehuman\tx\t')?.freedBytes).toBe(0);
    expect(parseCleanLine('rm: cannot remove')).toBeNull();
  });
});

describe('parseScheduleLine', () => {
  it('reads what a job install or removal answered', () => {
    expect(parseScheduleLine('@@ok')).toEqual({ ok: true, note: null });
    expect(parseScheduleLine('@@ok\tlater')).toEqual({ ok: true, note: 'later' });
    expect(parseScheduleLine('@@error\tnocron')).toEqual({ ok: false, error: 'nocron' });
    expect(parseScheduleLine('hello')).toBeNull();
  });
});
