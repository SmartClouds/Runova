import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeFileSends, setActiveFileSends, stopFileSendsForQuit } from './active';

afterEach(() => setActiveFileSends(null));

describe('file sends as the rest of main sees them', () => {
  it('counts nothing and stops nothing before sending is set up', () => {
    expect(activeFileSends()).toBe(0);
    expect(() => stopFileSendsForQuit()).not.toThrow();
  });

  it('asks the send service once it is there', () => {
    const stopForQuit = vi.fn();
    setActiveFileSends({ count: () => 2, stopForQuit });

    expect(activeFileSends()).toBe(2);
    stopFileSendsForQuit();
    expect(stopForQuit).toHaveBeenCalled();
  });
});
