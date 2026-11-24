import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ipcError, ZONE } from './testing/fixtures';

/**
 * Purging the cache (T3): listed URLs straight away, everything only after typing the domain's
 * name, since a full purge sends every visitor's next request to the server.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { PurgeCard } = await import('./PurgeCard');

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('PurgeCard', () => {
  it('purges the URLs listed, one per line', async () => {
    const { user, bridge } = renderWithProviders(<PurgeCard zone={ZONE} />, {
      bridge: { 'cloudflare.purgeCache': async () => undefined },
    });

    await user.type(
      screen.getByLabelText('URLs to purge'),
      'https://example.com/app.css{enter}https://example.com/app.js',
    );
    await user.click(screen.getByRole('button', { name: 'Purge these URLs' }));

    expect(bridge.$fn('cloudflare.purgeCache')).toHaveBeenCalledWith(ZONE.id, {
      urls: ['https://example.com/app.css', 'https://example.com/app.js'],
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Purged 2 URLs from the cache.'),
    );
    expect(screen.getByLabelText('URLs to purge')).toHaveValue('');
  });

  it('says what is wrong with the list before purging', async () => {
    const { user, bridge } = renderWithProviders(<PurgeCard zone={ZONE} />);

    await user.type(screen.getByLabelText('URLs to purge'), 'example.com/app.css');
    await user.click(screen.getByRole('button', { name: 'Purge these URLs' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Start it with https://');
    expect(() => bridge.$fn('cloudflare.purgeCache')).toThrow();
  });

  it('purges everything only once the domain name is typed', async () => {
    const { user, bridge } = renderWithProviders(<PurgeCard zone={ZONE} />, {
      bridge: { 'cloudflare.purgeCache': async () => undefined },
    });

    await user.click(screen.getByRole('button', { name: 'Purge everything' }));
    const dialog = await screen.findByRole('dialog', { name: 'Purge everything for example.com?' });
    const confirm = within(dialog).getByRole('button', { name: 'Purge everything' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'example.co');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'm');
    await user.click(confirm);

    expect(bridge.$fn('cloudflare.purgeCache')).toHaveBeenCalledWith(ZONE.id, { everything: true });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Purged everything for example.com.'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog open with the reason when the purge fails', async () => {
    const { user } = renderWithProviders(<PurgeCard zone={ZONE} />, {
      bridge: {
        'cloudflare.purgeCache': async () => {
          throw ipcError('purgeCache', 'This token is not allowed to purge the cache.');
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Purge everything' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/to confirm/), 'example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Purge everything' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not allowed to purge');
  });

  it('passes on a failed purge of listed URLs', async () => {
    const { user } = renderWithProviders(<PurgeCard zone={ZONE} />, {
      bridge: {
        'cloudflare.purgeCache': async () => {
          throw ipcError('purgeCache', 'Cloudflare took too long to answer.');
        },
      },
    });
    await user.type(screen.getByLabelText('URLs to purge'), 'https://example.com/a');
    await user.click(screen.getByRole('button', { name: 'Purge these URLs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('took too long');
  });

  describe('folders and hostnames', () => {
    it('offers URLs, folders and hostnames, starting on URLs', () => {
      renderWithProviders(<PurgeCard zone={ZONE} />);

      const choice = screen.getByRole('radiogroup', { name: 'What to purge' });
      expect(
        within(choice)
          .getAllByRole('radio')
          .map((radio) => radio.textContent),
      ).toEqual(['URLs', 'Folders', 'Hostnames']);
      expect(within(choice).getByRole('radio', { name: 'URLs' })).toBeChecked();
    });

    it('purges the folders listed, with the field, its help and the button saying folders', async () => {
      const { user, bridge } = renderWithProviders(<PurgeCard zone={ZONE} />, {
        bridge: { 'cloudflare.purgeCache': async () => undefined },
      });

      await user.click(screen.getByRole('radio', { name: 'Folders' }));
      const field = screen.getByLabelText('Folders to purge');
      expect(field).toHaveAttribute('placeholder', 'example.com/blog/');
      expect(screen.getByText(/Everything under it goes/)).toBeInTheDocument();
      await user.type(field, 'https://example.com/blog/');
      await user.click(screen.getByRole('button', { name: 'Purge these folders' }));

      expect(bridge.$fn('cloudflare.purgeCache')).toHaveBeenCalledWith(ZONE.id, {
        prefixes: ['example.com/blog/'],
      });
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Purged 1 folder from the cache.'),
      );
      expect(field).toHaveValue('');
    });

    it('purges the hostnames listed', async () => {
      const { user, bridge } = renderWithProviders(<PurgeCard zone={ZONE} />, {
        bridge: { 'cloudflare.purgeCache': async () => undefined },
      });

      await user.click(screen.getByRole('radio', { name: 'Hostnames' }));
      const field = screen.getByLabelText('Hostnames to purge');
      expect(field).toHaveAttribute('placeholder', 'www.example.com');
      await user.type(field, 'www.example.com{enter}shop.example.com');
      await user.click(screen.getByRole('button', { name: 'Purge these hostnames' }));

      expect(bridge.$fn('cloudflare.purgeCache')).toHaveBeenCalledWith(ZONE.id, {
        hosts: ['www.example.com', 'shop.example.com'],
      });
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Purged 2 hostnames from the cache.'),
      );
    });

    it('refuses a name on another domain before anything goes out', async () => {
      const { user, bridge } = renderWithProviders(<PurgeCard zone={ZONE} />);

      await user.click(screen.getByRole('radio', { name: 'Hostnames' }));
      await user.type(screen.getByLabelText('Hostnames to purge'), 'shop.other.com');
      await user.click(screen.getByRole('button', { name: 'Purge these hostnames' }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        'shop.other.com is not under example.com.',
      );
      expect(() => bridge.$fn('cloudflare.purgeCache')).toThrow();
    });

    it('keeps what was typed for each choice, and drops the problem on a switch', async () => {
      const { user } = renderWithProviders(<PurgeCard zone={ZONE} />);

      await user.type(screen.getByLabelText('URLs to purge'), 'example.com/a.css');
      await user.click(screen.getByRole('button', { name: 'Purge these URLs' }));
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: 'Folders' }));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByLabelText('Folders to purge')).toHaveValue('');
      await user.type(screen.getByLabelText('Folders to purge'), 'example.com/blog/');

      await user.click(screen.getByRole('radio', { name: 'URLs' }));
      expect(screen.getByLabelText('URLs to purge')).toHaveValue('example.com/a.css');
      await user.click(screen.getByRole('radio', { name: 'Folders' }));
      expect(screen.getByLabelText('Folders to purge')).toHaveValue('example.com/blog/');
    });
  });

  it('moves focus to the list each time it is asked to, so the header can bring you here', async () => {
    function Harness(): React.JSX.Element {
      const [request, setRequest] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setRequest((count) => count + 1)}>
            Bring me there
          </button>
          <PurgeCard zone={ZONE} focusRequest={request} />
        </>
      );
    }
    // jsdom has no scrolling, so record which element is asked to come into view.
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const { user } = renderWithProviders(<Harness />);
    expect(screen.getByLabelText('URLs to purge')).not.toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Bring me there' }));
    expect(screen.getByLabelText('URLs to purge')).toHaveFocus();
    // The whole card, so the URLs, Folders and Hostnames choice above the box shows too.
    await waitFor(() =>
      expect(scrolled).toEqual([
        screen.getByRole('heading', { name: 'Purge cache' }).closest('section'),
      ]),
    );
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');

    await user.click(screen.getByRole('button', { name: 'Bring me there' }));
    expect(screen.getByLabelText('URLs to purge')).toHaveFocus();
  });
});
