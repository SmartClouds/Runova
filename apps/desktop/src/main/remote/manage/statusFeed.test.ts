import { describe, expect, it } from 'vitest';
import { createStatusFeed, parseStatusFeed, type StatusFeedWindow } from './statusFeed';

function fakeWindow(): StatusFeedWindow & { fire(event: string): void } {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    on(event, listener) {
      listeners[event] = [...(listeners[event] ?? []), listener];
    },
    fire(event) {
      for (const listener of listeners[event] ?? []) listener();
    },
  };
}

const run = {
  id: 's1',
  title: 'dev',
  state: 'running',
  cpuPercent: 12.5,
  memBytes: 1024,
  urls: ['http://localhost:3000/'],
  device: null,
};
const plan = {
  key: 'split:p1',
  kind: 'split',
  projectName: 'Shop',
  status: 'running',
  startedAt: 1000,
  error: null,
};

describe('status feed', () => {
  it('knows nothing until a window has said something', () => {
    expect(createStatusFeed().current()).toBeNull();
  });

  it('holds what the window sent', () => {
    const feed = createStatusFeed();
    feed.publish(fakeWindow(), { runs: [run], plans: [plan] });
    expect(feed.current()).toEqual({ runs: [run], plans: [plan] });
  });

  it('forgets when the window closes or reloads', () => {
    for (const event of ['destroyed', 'did-navigate']) {
      const feed = createStatusFeed();
      const window = fakeWindow();
      feed.publish(window, { runs: [run], plans: [] });
      window.fire(event);
      expect(feed.current()).toBeNull();
    }
  });

  it('hears a window again after it has reloaded', () => {
    const feed = createStatusFeed();
    const window = fakeWindow();
    feed.publish(window, { runs: [run], plans: [] });
    window.fire('did-navigate');
    feed.publish(window, { runs: [], plans: [] });
    expect(feed.current()).toEqual({ runs: [], plans: [] });
  });

  it('ignores an older window closing while a newer one is talking', () => {
    const feed = createStatusFeed();
    const older = fakeWindow();
    feed.publish(older, { runs: [], plans: [] });
    feed.publish(fakeWindow(), { runs: [run], plans: [] });
    older.fire('destroyed');
    expect(feed.current()?.runs).toHaveLength(1);
  });

  it('keeps the last good answer when a window sends junk', () => {
    const feed = createStatusFeed();
    const window = fakeWindow();
    feed.publish(window, { runs: [run], plans: [] });
    feed.publish(window, 'nonsense');
    expect(feed.current()?.runs).toHaveLength(1);
  });

  it('drops malformed rows and caps what it keeps', () => {
    const many = Array.from({ length: 100 }, (_, n) => ({ ...run, id: `s${n}` }));
    const parsed = parseStatusFeed({
      runs: [...many, { id: 'x', title: 'x', state: 'exploded' }, 7],
      plans: [{ ...plan, kind: 'other' }, plan],
    });
    expect(parsed?.runs).toHaveLength(32);
    expect(parsed?.plans).toEqual([plan]);
  });

  it('never trusts a number it cannot use', () => {
    const parsed = parseStatusFeed({
      runs: [{ ...run, cpuPercent: 'lots', memBytes: -1 }],
      plans: [],
    });
    expect(parsed?.runs[0]).toMatchObject({ cpuPercent: null, memBytes: null });
  });
});
