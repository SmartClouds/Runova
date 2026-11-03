import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalRequest, createApprovalBroker } from './approvals';

/**
 * The approvals waiting on the user. Each one is answered once, by the window or by the CLI, and
 * one nobody answers counts as a no once its time is up.
 */

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  connectionId: 'conn-1',
  channel: 'modal',
  tool: 'env_save_file',
  toolTitle: 'Save an env file',
  area: 'environments',
  risk: 'sensitive',
  agent: 'Claude Code',
  callerKind: 'runova',
  projectId: 'p1',
  projectName: 'Shop',
  preview: { title: 'Update .env' },
  cliFallback: false,
  payload: { args: { content: 'A=1' } },
  ...over,
});

const WINDOW = { channel: 'modal' } as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('approval broker', () => {
  it('lists a waiting approval for the window and resolves it with the decision', async () => {
    const onChange = vi.fn();
    const broker = createApprovalBroker({ timeoutMs: 60_000, onChange });
    const { id, decision } = broker.request(request());

    expect(broker.listForWindow()).toEqual([
      expect.objectContaining({ id, tool: 'env_save_file', expiresAt: 1_060_000 }),
    ]);
    expect(broker.listForWindow()[0]).not.toHaveProperty('payload');
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(broker.decide(id, 'allow', WINDOW)).toEqual(
      expect.objectContaining({ payload: { args: { content: 'A=1' } } }),
    );
    await expect(decision).resolves.toBe('allow');
    expect(broker.listForWindow()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('answers each approval once', () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const { id } = broker.request(request());

    expect(broker.decide(id, 'deny', WINDOW)).not.toBeNull();
    expect(broker.decide(id, 'allow', WINDOW)).toBeNull();
    expect(broker.decide('nobody', 'allow', WINDOW)).toBeNull();
  });

  it('counts an approval nobody answered as timed out', async () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const { id, decision } = broker.request(request());

    vi.advanceTimersByTime(60_000);

    await expect(decision).resolves.toBe('timeout');
    expect(broker.decide(id, 'allow', WINDOW)).toBeNull();
  });

  it('keeps approvals the CLI asks about out of the window', () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    broker.request(request({ channel: 'cli' }));

    expect(broker.listForWindow()).toEqual([]);
  });

  it('lets the window answer only what it shows and a bridge only what it asked', () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const inCli = broker.request(request({ channel: 'cli' }));
    const inWindow = broker.request(request());

    expect(broker.decide(inCli.id, 'allow', WINDOW)).toBeNull();
    expect(
      broker.decide(inWindow.id, 'allow', { channel: 'cli', connectionId: 'conn-1' }),
    ).toBeNull();
    expect(broker.decide(inCli.id, 'allow', { channel: 'cli', connectionId: 'conn-2' })).toBeNull();
    expect(
      broker.decide(inCli.id, 'allow', { channel: 'cli', connectionId: 'conn-1' }),
    ).not.toBeNull();
    expect(broker.decide(inWindow.id, 'allow', WINDOW)).not.toBeNull();
  });

  it('remembers allow for this session per connection and tool', () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const { id } = broker.request(request());

    broker.decide(id, 'allow_session', WINDOW);

    expect(broker.isGranted('conn-1', 'env_save_file')).toBe(true);
    expect(broker.isGranted('conn-1', 'env_read_file')).toBe(false);
    expect(broker.isGranted('conn-2', 'env_save_file')).toBe(false);
  });

  it('forgets session grants and denies what is waiting when access is turned off', async () => {
    const broker = createApprovalBroker({ timeoutMs: 60_000 });
    const first = broker.request(request());
    broker.decide(first.id, 'allow_session', WINDOW);
    const second = broker.request(request({ tool: 'env_remove_file' }));

    broker.reset();

    expect(broker.isGranted('conn-1', 'env_save_file')).toBe(false);
    await expect(second.decision).resolves.toBe('deny');
    expect(broker.listForWindow()).toEqual([]);
  });
});
