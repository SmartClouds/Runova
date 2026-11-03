import { describe, expect, it } from 'vitest';
import { parseHostMessage, parseMainMessage, readyMessage, toCloneable } from './hostProtocol';

/**
 * Messages cross a process boundary, so each side checks what it receives before acting on it.
 * A malformed message is dropped rather than trusted.
 */

const input = {
  collection: { info: { name: 'x', schema: 's' }, item: [] },
  options: {
    timeoutMs: 1000,
    strictSSL: true,
    followRedirects: true,
    maxInlineBodyBytes: 10,
    scriptsEnabled: false,
    proxy: null,
  },
};

describe('parseMainMessage', () => {
  it('accepts run and cancel', () => {
    expect(parseMainMessage({ type: 'run', runId: 'r1', input })).toEqual({
      type: 'run',
      runId: 'r1',
      input,
    });
    expect(parseMainMessage({ type: 'cancel', runId: 'r1' })).toEqual({
      type: 'cancel',
      runId: 'r1',
    });
  });

  it('rejects anything else', () => {
    expect(parseMainMessage(null)).toBeNull();
    expect(parseMainMessage('run')).toBeNull();
    expect(parseMainMessage({ type: 'run', runId: 'r1' })).toBeNull();
    expect(parseMainMessage({ type: 'run', runId: '', input })).toBeNull();
    expect(parseMainMessage({ type: 'run', runId: 'r', input: { collection: {} } })).toBeNull();
    expect(parseMainMessage({ type: 'exec', runId: 'r1' })).toBeNull();
  });
});

describe('readyMessage', () => {
  it('reads the version the runtime reports through its version() function', () => {
    const message = readyMessage({ version: () => ({ version: '7.56.1', dependencies: {} }) });
    expect(message).toEqual({ type: 'ready', runtimeVersion: '7.56.1' });
    // Posting a message clones it; a function or class instance in it would throw.
    expect(() => structuredClone(message)).not.toThrow();
  });

  it('copes with a plain string or nothing at all', () => {
    expect(readyMessage({ version: '7.0.0' }).runtimeVersion).toBe('7.0.0');
    expect(readyMessage({}).runtimeVersion).toBe('unknown');
    expect(
      readyMessage({
        version: () => {
          throw new Error('no');
        },
      }).runtimeVersion,
    ).toBe('unknown');
  });
});

describe('toCloneable', () => {
  it('passes plain data through and flattens anything a message cannot carry', () => {
    expect(toCloneable({ a: 1, b: ['x'] })).toEqual({ a: 1, b: ['x'] });
    const flattened = toCloneable({ fn: () => 1, nested: { when: new Date(0) } });
    expect(() => structuredClone(flattened)).not.toThrow();
    expect(flattened).toEqual({ nested: { when: '1970-01-01T00:00:00.000Z' } });
  });
});

describe('parseHostMessage', () => {
  it('accepts alive, ready, event, done and fatal', () => {
    expect(parseHostMessage({ type: 'alive' })).toEqual({ type: 'alive' });
    expect(parseHostMessage({ type: 'ready', runtimeVersion: '7.56.1' })).toEqual({
      type: 'ready',
      runtimeVersion: '7.56.1',
    });
    const event = { type: 'console', itemId: null, level: 'log', messages: ['a'] };
    expect(parseHostMessage({ type: 'event', runId: 'r', event })).toEqual({
      type: 'event',
      runId: 'r',
      event,
    });
    const summary = {
      error: null,
      cancelled: false,
      environment: [],
      globals: [],
      collectionVariables: [],
    };
    expect(parseHostMessage({ type: 'done', runId: 'r', summary })).toEqual({
      type: 'done',
      runId: 'r',
      summary,
    });
    expect(parseHostMessage({ type: 'fatal', error: 'boom' })).toEqual({
      type: 'fatal',
      error: 'boom',
    });
  });

  it('rejects events and summaries of the wrong shape', () => {
    expect(parseHostMessage({ type: 'event', runId: 'r', event: { type: 'nope' } })).toBeNull();
    expect(parseHostMessage({ type: 'event', runId: 'r' })).toBeNull();
    expect(parseHostMessage({ type: 'done', runId: 'r', summary: { error: 1 } })).toBeNull();
    expect(parseHostMessage({ type: 'ready' })).toBeNull();
    expect(parseHostMessage(42)).toBeNull();
  });
});
