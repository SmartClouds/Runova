import { beforeEach, describe, expect, it, vi } from 'vitest';

const ghApi = vi.hoisted(() => vi.fn());
vi.mock('../../git/githubCli', () => ({ ghApi }));

const { fetchRegisteredRunners } = await import('./github');

beforeEach(() => {
  ghApi.mockReset();
});

describe('fetchRegisteredRunners', () => {
  it('lists a repo’s runners by id and name', async () => {
    ghApi.mockResolvedValue({
      total_count: 2,
      runners: [
        { id: 1, name: 'a', status: 'online' },
        { id: 2, name: 'b', status: 'offline' },
      ],
    });
    expect(await fetchRegisteredRunners({ kind: 'repo', name: 'acme/web' })).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    expect(ghApi).toHaveBeenCalledWith('repos/acme/web/actions/runners?per_page=100');
  });

  it('asks the org endpoint for an org', async () => {
    ghApi.mockResolvedValue({ total_count: 0, runners: [] });
    expect(await fetchRegisteredRunners({ kind: 'org', name: 'acme' })).toEqual([]);
    expect(ghApi).toHaveBeenCalledWith('orgs/acme/actions/runners?per_page=100');
  });

  it('cannot say when GitHub refuses, fails or has more than one page', async () => {
    ghApi.mockRejectedValueOnce(new Error('HTTP 403'));
    expect(await fetchRegisteredRunners({ kind: 'repo', name: 'acme/web' })).toBeNull();
    ghApi.mockResolvedValueOnce({ total_count: 150, runners: [{ id: 1, name: 'a' }] });
    expect(await fetchRegisteredRunners({ kind: 'repo', name: 'acme/web' })).toBeNull();
    ghApi.mockResolvedValueOnce({ nope: true });
    expect(await fetchRegisteredRunners({ kind: 'repo', name: 'acme/web' })).toBeNull();
  });

  it('never asks for a name that is not a repo or an org', async () => {
    expect(await fetchRegisteredRunners({ kind: 'repo', name: '../x' })).toBeNull();
    expect(await fetchRegisteredRunners({ kind: 'org', name: 'a/b' })).toBeNull();
    expect(ghApi).not.toHaveBeenCalled();
  });
});
