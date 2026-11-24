import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastHistoryStore } from '@/stores/toastHistoryStore';

/**
 * The capture hooks sonner is typed helpers, so the real ones are replaced first: what is being
 * tested is what ends up in the history, not what sonner draws.
 */
const shown = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown[] }[] }));

vi.mock('sonner', () => {
  const make = (name: string) =>
    vi.fn((...args: unknown[]) => {
      shown.calls.push({ name, args });
      return `id-${shown.calls.length}`;
    });
  return {
    toast: {
      success: make('success'),
      info: make('info'),
      warning: make('warning'),
      error: make('error'),
      message: make('message'),
    },
  };
});

const { toast } = await import('sonner');
const { installToastHistoryCapture, replayToast, showLinkedToast } = await import('./toastHistory');

installToastHistoryCapture();

function items() {
  return useToastHistoryStore.getState().items;
}

beforeEach(() => {
  shown.calls = [];
  useToastHistoryStore.setState({ items: [], open: false });
});

describe('installToastHistoryCapture', () => {
  it('still shows the toast, and records it under its own kind', () => {
    toast.success('Saved');
    expect(shown.calls).toEqual([{ name: 'success', args: ['Saved', undefined] }]);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ kind: 'success', title: 'Saved', description: '' });
  });

  it('records each kind sonner exposes', () => {
    toast.info('I');
    toast.warning('W');
    toast.error('E');
    toast.message('M');
    expect(items().map((item) => item.kind)).toEqual(['message', 'error', 'warning', 'info']);
  });

  it('keeps the description alongside the title', () => {
    toast.error('Push failed', { description: 'The remote rejected it.' });
    expect(items()[0]).toMatchObject({
      title: 'Push failed',
      description: 'The remote rejected it.',
    });
  });

  it('is installed only once, so a toast is never recorded twice', () => {
    installToastHistoryCapture();
    installToastHistoryCapture();
    toast.success('Saved');
    expect(items()).toHaveLength(1);
  });

  it('reads the text out of a toast built from elements', () => {
    // Sibling children are joined with a space, so the row reads like a sentence.
    toast.success(createElement('span', null, 'Copied', createElement('b', null, 'password')));
    expect(items()[0].title).toBe('Copied password');
  });

  it('records a number as its text', () => {
    toast.info(3);
    expect(items()[0].title).toBe('3');
  });

  it('promotes the description when a toast has no title of its own', () => {
    toast.info('', { description: 'Just the detail' });
    expect(items()[0]).toMatchObject({ title: 'Just the detail', description: '' });
  });

  it('records nothing for a toast with no readable text at all', () => {
    // A custom toast rendered from a function has nothing to write into a history row.
    toast.message(() => createElement('div'));
    toast.info('   ');
    expect(items()).toHaveLength(0);
  });

  it('rolls a repeated toast into one row with a count', () => {
    toast.error('Push failed');
    toast.error('Push failed');
    expect(items()).toHaveLength(1);
    expect(items()[0].count).toBe(2);
  });
});

describe('replayToast', () => {
  it('shows the toast again without adding a second history row', () => {
    replayToast('success', 'Saved', '');
    expect(shown.calls).toEqual([{ name: 'success', args: ['Saved', undefined] }]);
    expect(items()).toHaveLength(0);
  });

  it('passes the description along when there is one', () => {
    replayToast('error', 'Push failed', 'The remote rejected it.');
    expect(shown.calls[0].args).toEqual([
      'Push failed',
      { description: 'The remote rejected it.' },
    ]);
  });

  it('replays a plain message through sonner is message helper', () => {
    replayToast('message', 'FYI', '');
    expect(shown.calls[0].name).toBe('message');
  });

  it('goes back to recording once the replay is done', () => {
    replayToast('info', 'Old', '');
    toast.info('New');
    expect(items().map((item) => item.title)).toEqual(['New']);
  });
});

describe('showLinkedToast', () => {
  it('names its button, adds a second one, and keeps one history row with the link', () => {
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    showLinkedToast(
      {
        kind: 'error',
        title: "Couldn't clone My app",
        description: 'Repository not found.',
        link: { route: '/projects/p1?tab=git' },
        projectId: 'p1',
      },
      onRetry,
      {
        actionLabel: 'Try again',
        secondary: { label: 'Open Git tab', onClick: onOpen },
        duration: 12000,
      },
    );

    expect(shown.calls).toHaveLength(1);
    const options = shown.calls[0]?.args[1] as {
      action: { label: string; onClick: () => void };
      cancel: { label: string; onClick: () => void };
      duration: number;
    };
    expect(options.action.label).toBe('Try again');
    expect(options.cancel.label).toBe('Open Git tab');
    expect(options.duration).toBe(12000);
    options.action.onClick();
    options.cancel.onClick();
    expect(onRetry).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalled();

    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({
      kind: 'error',
      link: { route: '/projects/p1?tab=git' },
      projectId: 'p1',
    });
  });
});
