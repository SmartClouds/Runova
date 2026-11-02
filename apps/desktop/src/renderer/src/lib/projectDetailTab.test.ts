import { describe, expect, it } from 'vitest';
import { rememberable, restoreTarget } from './projectDetailTab';

describe('rememberable', () => {
  it('has nothing to keep on Overview', () => {
    expect(rememberable(new URLSearchParams())).toBeNull();
  });

  it('keeps the tab', () => {
    expect(rememberable(new URLSearchParams('tab=packages'))).toBe('tab=packages');
  });

  it('keeps the sub-view next to its tab', () => {
    expect(rememberable(new URLSearchParams('tab=prompts&view=scheduled'))).toBe(
      'tab=prompts&view=scheduled',
    );
  });

  it('leaves out anything that was meant for one visit', () => {
    expect(rememberable(new URLSearchParams('tab=git&edit=run&createRun=ai'))).toBe('tab=git');
  });

  it('does not keep a sub-view without a tab', () => {
    expect(rememberable(new URLSearchParams('view=errors'))).toBeNull();
  });
});

describe('restoreTarget', () => {
  it('opens the remembered tab when the address says nothing', () => {
    const target = restoreTarget(new URLSearchParams(), 'tab=security');
    expect(target?.toString()).toBe('tab=security');
  });

  it('brings the sub-view back too', () => {
    const target = restoreTarget(new URLSearchParams(), 'tab=prompts&view=drafts');
    expect(target?.toString()).toBe('tab=prompts&view=drafts');
  });

  it('leaves the address alone when nothing was remembered', () => {
    expect(restoreTarget(new URLSearchParams(), null)).toBeNull();
    expect(restoreTarget(new URLSearchParams(), '')).toBeNull();
  });

  it('lets a link to a tab win', () => {
    expect(restoreTarget(new URLSearchParams('tab=git'), 'tab=security')).toBeNull();
  });

  it('does not override a one-shot param on the way in', () => {
    expect(restoreTarget(new URLSearchParams('edit=run'), 'tab=security')).toBeNull();
    expect(restoreTarget(new URLSearchParams('createRun=ai'), 'tab=security')).toBeNull();
  });

  it('ignores a remembered address that names no tab', () => {
    expect(restoreTarget(new URLSearchParams(), 'view=errors')).toBeNull();
  });
});
