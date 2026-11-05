import type { CleanResult, ProviderScan } from '@runova/core';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ResultNotice } from './ResultNotice';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function provider(id: ProviderScan['id'], label: string): ProviderScan {
  return { id, label } as ProviderScan;
}

function result(over: Partial<CleanResult> = {}): CleanResult {
  return {
    providerId: 'nuget',
    removed: 3,
    freedBytes: 2.4 * GB,
    failed: [],
    skipped: [],
    cancelled: false,
    provider: provider('nuget', 'NuGet'),
    ...over,
  };
}

function render(over: Partial<React.ComponentProps<typeof ResultNotice>> = {}) {
  const props = {
    results: [result()],
    error: null,
    onDismiss: vi.fn(),
    onScan: vi.fn(),
    ...over,
  };
  return { props, ...renderWithProviders(<ResultNotice {...props} />) };
}

describe('ResultNotice', () => {
  it('says what was freed, and from which cache', () => {
    render();
    expect(screen.getByRole('status')).toHaveTextContent('Freed 2.40 GB from NuGet.');
  });

  it('adds up several caches cleaned in one go', () => {
    render({
      results: [
        result({ freedBytes: 2 * GB }),
        result({ providerId: 'bun', freedBytes: 1 * GB, provider: provider('bun', 'Bun') }),
      ],
    });
    expect(screen.getByRole('status')).toHaveTextContent('Freed 3.00 GB from 2 caches.');
  });

  it('can be put away', async () => {
    const { props, user } = render();
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('says honestly when some of it could not go, and why, as an alert', () => {
    render({
      results: [
        result({
          removed: 2,
          freedBytes: 1 * GB,
          failed: [
            { itemId: 'a', label: 'acornima 1.0.0', reason: 'It is in use by another program.' },
            { itemId: 'b', label: 'sass 2.0.0', reason: 'It changed after the scan.' },
          ],
        }),
      ],
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Freed 1.00 GB. 2 items could not be removed.');
    const list = within(alert).getByRole('list');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'NuGet: acornima 1.0.0, It is in use by another program.',
      'NuGet: sass 2.0.0, It changed after the scan.',
    ]);
  });

  it('says one item in the singular', () => {
    render({
      results: [result({ failed: [{ itemId: 'a', label: 'a 1.0.0', reason: 'In use.' }] })],
    });
    expect(screen.getByRole('alert')).toHaveTextContent('1 item could not be removed.');
  });

  it('lists only the first few failures and counts the rest', () => {
    const failed = Array.from({ length: 9 }, (_, index) => ({
      itemId: `i${index}`,
      label: `pkg ${index}`,
      reason: 'In use.',
    }));
    render({ results: [result({ removed: 0, freedBytes: 0, failed })] });
    const items = within(screen.getByRole('alert')).getAllByRole('listitem');
    // Five failures, then one line that counts the rest.
    expect(items).toHaveLength(6);
    expect(items[0]).toHaveTextContent('NuGet: pkg 0, In use.');
    expect(items[5]).toHaveTextContent('and 4 more');
  });

  it('says nothing could be removed when nothing was', () => {
    render({
      results: [
        result({
          removed: 0,
          freedBytes: 0,
          failed: [{ itemId: 'a', label: 'a 1.0.0', reason: 'In use.' }],
        }),
      ],
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing could be removed.');
  });

  it('says when it was stopped, and what was freed before that', () => {
    render({ results: [result({ cancelled: true, freedBytes: 500 * MB })] });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Stopped. Freed 500 MB before it stopped.',
    );
  });

  it('says when there was nothing to remove', () => {
    render({ results: [result({ removed: 0, freedBytes: 0 })] });
    expect(screen.getByRole('status')).toHaveTextContent('There was nothing to remove.');
  });

  it('mentions what it left alone on purpose', () => {
    render({
      results: [
        result({
          skipped: [
            {
              label: 'odd',
              reason: 'The versions could not be put in order, so none were removed.',
            },
          ],
        }),
      ],
    });
    expect(screen.getByText(/left alone/i)).toHaveTextContent(
      'Left alone: odd, The versions could not be put in order, so none were removed.',
    );
  });

  it('shows an error with a way to scan again', async () => {
    const { props, user } = render({ results: [], error: 'That scan is out of date.' });
    expect(screen.getByRole('alert')).toHaveTextContent('That scan is out of date.');
    await user.click(screen.getByRole('button', { name: /scan again/i }));
    expect(props.onScan).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when there is nothing to say', () => {
    const { container } = render({ results: [], error: null });
    expect(container).toBeEmptyDOMElement();
  });
});
