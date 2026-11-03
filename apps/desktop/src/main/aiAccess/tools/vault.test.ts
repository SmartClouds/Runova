import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultService } from '../../vault/service';
import { MemoryVaultFiles } from '../../vault/testing/memoryVaultFiles';
import type { AiTool, ToolContext } from '../registry';

const vault = vi.hoisted(() => ({ service: null as unknown }));

vi.mock('../../vault', () => ({ getVaultService: () => vault.service }));

/**
 * Vault tools, against a real vault kept in memory: list without secrets, reveal one value,
 * add an entry and update one. A locked vault is never unlocked for the agent.
 */

const PASSWORD = 'correct horse battery staple';
const context: ToolContext = { projectId: null, callerKind: 'external', agent: 'Codex', cwd: null };
let service: VaultService;
let tools: Map<string, AiTool>;
let githubId: string;

beforeEach(async () => {
  service = new VaultService({
    files: new MemoryVaultFiles(),
    cost: { N: 1024, r: 8, p: 1 },
    clipboard: { readText: () => '', writeText: () => undefined },
    events: {
      stateChanged: vi.fn(),
      entriesChanged: vi.fn(),
      clipboardSettled: vi.fn(),
    },
    env: {},
    isPackaged: false,
  });
  vault.service = service;
  await service.create(PASSWORD);
  githubId = (
    await service.save({
      type: 'login',
      title: 'GitHub',
      tags: ['work'],
      favorite: true,
      notes: 'NOTE-SENTINEL',
      username: 'octo',
      password: 'PASSWORD-SENTINEL',
      urls: ['https://github.com/login'],
      totpSecret: 'TOTP-SENTINEL',
    })
  ).id;
  await service.save({
    type: 'apiKey',
    title: 'Stripe',
    tags: [],
    favorite: false,
    service: 'Stripe',
    keyId: 'pk_live',
    secret: 'SECRET-SENTINEL',
  });
  const { vaultTools } = await import('./vault');
  tools = new Map(vaultTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown>) {
  const tool = tools.get(name) as AiTool;
  return tool.preview(tool.input.parse(args), context);
}

describe('vault tools', () => {
  it('lists entries with names, kind, username and urls, and no secret values', async () => {
    const data = (await run('vault_list')).data as Record<string, unknown>[];
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: githubId,
          title: 'GitHub',
          kind: 'login',
          username: 'octo',
          urls: ['https://github.com/login'],
          hasPassword: true,
        }),
        expect.objectContaining({ title: 'Stripe', kind: 'apiKey', hasSecret: true }),
      ]),
    );
    expect(JSON.stringify(data)).not.toMatch(/SENTINEL/);
    expect((await run('vault_list', { search: 'strip' })).data).toEqual([
      expect.objectContaining({ title: 'Stripe' }),
    ]);
  });

  it('reveals the main secret by default, or the field asked for', async () => {
    expect((await run('vault_reveal', { entry: 'github' })).text).toBe('PASSWORD-SENTINEL');
    expect((await run('vault_reveal', { entry: 'Stripe' })).text).toBe('SECRET-SENTINEL');
    expect((await run('vault_reveal', { entry: githubId, field: 'totpSecret' })).text).toBe(
      'TOTP-SENTINEL',
    );
    expect(await preview('vault_reveal', { entry: 'GitHub' })).toMatchObject({
      title: 'Reveal the password of GitHub',
    });
    await expect(run('vault_reveal', { entry: 'GitHub', field: 'secret' })).rejects.toThrow(
      'GitHub has no secret',
    );
  });

  it('adds a new entry, keeping the password out of the preview text', async () => {
    const args = {
      kind: 'login',
      title: 'Grafana',
      username: 'admin',
      password: 'NEW-PASSWORD',
      urls: ['https://grafana.local'],
    };
    const shown = await preview('vault_add_entry', args);
    expect(shown).toMatchObject({ title: 'Add Grafana to the vault' });
    expect(shown.fields).toContainEqual(
      expect.objectContaining({ label: 'Password', value: 'NEW-PASSWORD', secret: true }),
    );
    expect((await run('vault_add_entry', args)).text).toContain('Added Grafana');
    const added = service.list().find((entry) => entry.title === 'Grafana');
    expect(added).toMatchObject({ type: 'login', username: 'admin', hasPassword: true });
    await expect(
      run('vault_add_entry', { kind: 'note', title: 'Bad', password: 'x' }),
    ).rejects.toThrow('A note has no password');
  });

  it('updates only the fields given and keeps the rest', async () => {
    const tool = tools.get('vault_update_entry') as AiTool;
    expect(tool.risk).toBe('sensitive');
    expect(tools.get('vault_add_entry')?.risk).toBe('write');
    await run('vault_update_entry', { entry: 'GitHub', password: 'ROTATED' });
    expect(service.reveal(githubId, 'password')).toBe('ROTATED');
    expect(service.reveal(githubId, 'totpSecret')).toBe('TOTP-SENTINEL');
    expect(service.reveal(githubId, 'notes')).toBe('NOTE-SENTINEL');
    expect(service.getForEdit(githubId)).toMatchObject({
      title: 'GitHub',
      username: 'octo',
      tags: ['work'],
      favorite: true,
    });
    await expect(run('vault_update_entry', { entry: 'GitHub' })).rejects.toThrow(
      'Nothing to change',
    );
  });

  it('refuses while the vault is locked instead of asking for the password', async () => {
    await service.lock('manual');
    for (const [name, args] of [
      ['vault_list', {}],
      ['vault_reveal', { entry: 'GitHub' }],
      ['vault_add_entry', { kind: 'note', title: 'x' }],
    ] as const) {
      await expect(run(name, args)).rejects.toThrow('Unlock the vault in Runova first');
    }
  });

  it('never offers export or import', () => {
    for (const name of tools.keys()) expect(name).not.toMatch(/export|import|csv/);
  });
});
