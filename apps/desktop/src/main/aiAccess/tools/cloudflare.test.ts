import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareDnsRecord, CloudflareZone } from '../../../shared/cloudflareTypes';
import type { CloudflareService } from '../../deploy/cloudflare/service';
import type { AiTool, ToolContext } from '../registry';

/**
 * The Cloudflare tools: the zones and DNS records the Cloudflare dialog shows, and adding,
 * changing or removing a record through the same service. The token never comes back.
 */

const ZONE = 'a'.repeat(32);
const RECORD = 'b'.repeat(32);

const zone: CloudflareZone = {
  id: ZONE,
  accountId: 'acc-1',
  cloudflareAccountId: 'c'.repeat(32),
  name: 'example.com',
  status: 'active',
  paused: false,
  plan: 'Free Website',
  nameServers: ['ada.ns.cloudflare.com'],
};

const record: CloudflareDnsRecord = {
  id: RECORD,
  type: 'A',
  name: 'www.example.com',
  content: '203.0.113.10',
  ttl: 1,
  proxied: true,
  proxiable: true,
  editable: true,
};

const cloudflare = {
  status: vi.fn(async () => ({
    configured: true,
    locked: false,
    accounts: [{ id: 'acc-1', label: 'Work', locked: false, report: null }],
  })),
  allZones: vi.fn(async () => [zone]),
  listRecords: vi.fn(async (_zone: string) => [record]),
  createRecord: vi.fn(async (_zone: string, input: Record<string, unknown>) => ({
    ...record,
    ...input,
    id: 'd'.repeat(32),
  })),
  updateRecord: vi.fn(async (_zone: string, _id: string, input: Record<string, unknown>) => ({
    ...record,
    ...input,
  })),
  deleteRecord: vi.fn(async (_zone: string, _id: string) => undefined),
};

const context: ToolContext = { projectId: null, callerKind: 'external', agent: 'Codex', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  vi.clearAllMocks();
  // Imported after the modules reset, so the tools see the same store of services.
  const { setLiveDeployServices } = await import('../../deploy/liveServices');
  setLiveDeployServices({ cloudflare: cloudflare as unknown as CloudflareService });
  const { cloudflareTools } = await import('./cloudflare');
  tools = new Map(cloudflareTools.map((tool) => [tool.name, tool]));
});

function tool(name: string): AiTool {
  return tools.get(name) as AiTool;
}

async function run(name: string, args: Record<string, unknown> = {}) {
  return tool(name).run(tool(name).input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown>) {
  return tool(name).preview(tool(name).input.parse(args), context);
}

describe('cloudflare tools', () => {
  it('reads only, or marks the DNS changes sensitive', () => {
    for (const one of tools.values()) {
      expect(one.area).toBe('cloudflare');
      expect(one.name.startsWith('cloudflare_')).toBe(true);
    }
    expect(tool('cloudflare_zones').risk).toBe('read');
    expect(tool('cloudflare_dns_records').risk).toBe('read');
    expect(tool('cloudflare_dns_save').risk).toBe('sensitive');
    expect(tool('cloudflare_dns_remove').risk).toBe('sensitive');
  });

  it('lists the zones with the account each is in, and never a token', async () => {
    const data = (await run('cloudflare_zones')).data;
    expect(data).toEqual([
      expect.objectContaining({
        id: ZONE,
        name: 'example.com',
        status: 'active',
        account: 'Work',
        nameServers: ['ada.ns.cloudflare.com'],
      }),
    ]);
    expect(JSON.stringify(data)).not.toMatch(/token/i);
  });

  it('lists the records of a zone found by its domain, filtered by type', async () => {
    const data = (await run('cloudflare_dns_records', { zone: 'Example.com.', type: 'A' }))
      .data as CloudflareDnsRecord[];
    expect(cloudflare.listRecords).toHaveBeenCalledWith(ZONE);
    expect(data).toEqual([expect.objectContaining({ id: RECORD, content: '203.0.113.10' })]);
    expect(
      (await run('cloudflare_dns_records', { zone: ZONE, type: 'TXT' })).data as unknown[],
    ).toEqual([]);
  });

  it('adds a record, turning a short name into a full one, with the editor checks', async () => {
    await run('cloudflare_dns_save', {
      zone: 'example.com',
      type: 'A',
      name: 'api',
      content: '203.0.113.20',
    });
    expect(cloudflare.createRecord).toHaveBeenCalledWith(ZONE, {
      type: 'A',
      name: 'api.example.com',
      content: '203.0.113.20',
      ttl: 1,
      proxied: false,
    });
    await expect(
      run('cloudflare_dns_save', { zone: 'example.com', type: 'A', name: 'api', content: 'nope' }),
    ).rejects.toThrow();
    expect(cloudflare.createRecord).toHaveBeenCalledTimes(1);
  });

  it('changes a record by id, showing what it holds now in the approval', async () => {
    const args = {
      zone: 'example.com',
      recordId: RECORD,
      type: 'A',
      name: 'www',
      content: '203.0.113.30',
      proxied: true,
    };
    const shown = await preview('cloudflare_dns_save', args);
    expect(shown.title).toContain('www.example.com');
    expect(JSON.stringify(shown.fields)).toContain('203.0.113.10');
    expect(JSON.stringify(shown.fields)).toContain('203.0.113.30');
    await run('cloudflare_dns_save', args);
    expect(cloudflare.updateRecord).toHaveBeenCalledWith(
      ZONE,
      RECORD,
      expect.objectContaining({ name: 'www.example.com', content: '203.0.113.30', proxied: true }),
    );
  });

  it('removes a record it can find, and refuses one the zone does not have', async () => {
    const shown = await preview('cloudflare_dns_remove', { zone: 'example.com', recordId: RECORD });
    expect(shown.title).toContain('www.example.com');
    await run('cloudflare_dns_remove', { zone: 'example.com', recordId: RECORD });
    expect(cloudflare.deleteRecord).toHaveBeenCalledWith(ZONE, RECORD);
    await expect(
      run('cloudflare_dns_remove', { zone: 'example.com', recordId: 'e'.repeat(32) }),
    ).rejects.toThrow(/no record/i);
  });

  it('passes on what Cloudflare said without the code tag', async () => {
    cloudflare.allZones.mockRejectedValueOnce(
      new Error('[cloudflare:no-token] Connect Cloudflare first.'),
    );
    await expect(run('cloudflare_zones')).rejects.toThrow(/^Connect Cloudflare first\.$/);
  });

  it('says so when a zone is not in any connected account', async () => {
    await expect(run('cloudflare_dns_records', { zone: 'other.org' })).rejects.toThrow(
      /other\.org/,
    );
  });
});
