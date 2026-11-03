import { AI_ACCESS_MODES } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { AI_TOOL_RISKS } from '../../shared/aiAccessTypes';
import { decidePolicy } from './policy';

/** Which calls go through and which wait for the user, for every mode and kind of tool. */

describe('decidePolicy', () => {
  it('never asks in full access', () => {
    for (const risk of AI_TOOL_RISKS) {
      expect(decidePolicy({ mode: 'full', risk, granted: false })).toBe('allow');
    }
  });

  it('asks only before sensitive actions in the sensitive mode', () => {
    expect(decidePolicy({ mode: 'sensitive', risk: 'read', granted: false })).toBe('allow');
    expect(decidePolicy({ mode: 'sensitive', risk: 'write', granted: false })).toBe('allow');
    expect(decidePolicy({ mode: 'sensitive', risk: 'sensitive', granted: false })).toBe('ask');
  });

  it('asks before every call, reads included, in the strictest mode', () => {
    for (const risk of AI_TOOL_RISKS) {
      expect(decidePolicy({ mode: 'all', risk, granted: false })).toBe('ask');
    }
  });

  it('lets a tool the user allowed for this session through in every mode', () => {
    for (const mode of AI_ACCESS_MODES) {
      for (const risk of AI_TOOL_RISKS) {
        expect(decidePolicy({ mode, risk, granted: true })).toBe('allow');
      }
    }
  });
});
