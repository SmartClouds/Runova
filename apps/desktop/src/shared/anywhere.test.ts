import { describe, expect, it } from 'vitest';
import { formatRemoteId, formatTypedRemoteId, parseRemoteId } from './anywhere';

describe('Runova IDs in the app', () => {
  it('shows an ID in groups of three', () => {
    expect(formatRemoteId('482193775')).toBe('482 193 775');
    expect(formatRemoteId('482 193 775')).toBe('482 193 775');
    expect(formatRemoteId('12')).toBe('12');
  });

  it('reads a typed or pasted ID', () => {
    expect(parseRemoteId('482 193 775')).toBe('482193775');
    expect(parseRemoteId('482-193-775')).toBe('482193775');
    expect(parseRemoteId('482193775 ')).toBe('482193775');
    expect(parseRemoteId('082193775')).toBeNull();
    expect(parseRemoteId('48219377')).toBeNull();
    expect(parseRemoteId('Sam desk')).toBeNull();
  });

  it('groups digits while someone types, and stops at nine', () => {
    expect(formatTypedRemoteId('4')).toBe('4');
    expect(formatTypedRemoteId('4821')).toBe('482 1');
    expect(formatTypedRemoteId('482193775123')).toBe('482 193 775');
    expect(formatTypedRemoteId('48a2')).toBe('482');
  });
});
