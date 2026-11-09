import { describe, expect, it } from 'vitest';
import { versionOnChannel } from './version.js';

describe('versionOnChannel', () => {
  it('leaves a stable version as it is', () => {
    expect(versionOnChannel('1.3.0', 'stable', 'v', ['v1.3.0-beta.1'])).toBe('1.3.0');
  });

  it('starts a channel at one', () => {
    expect(versionOnChannel('1.3.0', 'beta', 'v', [])).toBe('1.3.0-beta.1');
  });

  it('takes the next free number on that channel only', () => {
    const tags = ['v1.3.0-beta.1', 'v1.3.0-beta.2', 'v1.3.0-preview.7'];
    expect(versionOnChannel('1.3.0', 'beta', 'v', tags)).toBe('1.3.0-beta.3');
  });

  it('ignores tags from another prefix', () => {
    expect(versionOnChannel('1.3.0', 'beta', 'web-v', ['v1.3.0-beta.4'])).toBe('1.3.0-beta.1');
  });
});
