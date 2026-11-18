import type { SendRecipient } from '@shared/fileSend';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RecipientPicker } from './RecipientPicker';

function recipient(change: Partial<SendRecipient>): SendRecipient {
  return {
    remoteId: '100000111',
    name: "Sam's laptop",
    platform: 'windows',
    kind: 'computer',
    relation: 'own',
    owner: { userId: 1, displayName: 'Sam', email: 'sam@example.com' },
    teams: [],
    online: true,
    unavailable: null,
    ...change,
  };
}

const laptop = recipient({});
const kims = recipient({
  remoteId: '100000222',
  name: "Kim's laptop",
  platform: 'macos',
  relation: 'teammate',
  owner: { userId: 2, displayName: 'Kim Park', email: 'kim@example.com' },
  teams: ['Ops'],
});
const offline = recipient({
  remoteId: '100000333',
  name: 'Build box',
  online: false,
  unavailable: 'offline',
});
const older = recipient({ remoteId: '100000444', name: 'Old desk', unavailable: 'outdated' });

function picker(recipients: SendRecipient[], value: string | null = null, websiteOutdated = false) {
  const onChange = vi.fn();
  const view = renderWithProviders(
    <RecipientPicker
      recipients={recipients}
      value={value}
      onChange={onChange}
      websiteOutdated={websiteOutdated}
    />,
  );
  return { ...view, onChange };
}

describe('picking who to send to', () => {
  it('groups my devices apart from teammates, and teammates by person', () => {
    picker([laptop, kims]);

    const group = screen.getByRole('radiogroup', { name: 'Send to' });
    expect(within(group).getByText('My devices')).toBeInTheDocument();
    expect(within(group).getByText('Kim Park')).toBeInTheDocument();
    expect(within(group).getByText('Ops')).toBeInTheDocument();
  });

  it('picks one device', async () => {
    const { user, onChange } = picker([laptop, kims], laptop.remoteId);

    expect(screen.getByRole('radio', { name: /Sam's laptop/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('radio', { name: /Kim's laptop/ }));

    expect(onChange).toHaveBeenCalledWith(kims.remoteId);
  });

  it('can not pick a device that can not take files, and says why', async () => {
    const { user, onChange } = picker([offline, older]);

    const box = screen.getByRole('radio', { name: /Build box/ });
    expect(box).toBeDisabled();
    expect(within(box).getByText('Offline')).toBeInTheDocument();
    expect(
      within(screen.getByRole('radio', { name: /Old desk/ })).getByText('Needs a newer Runova'),
    ).toBeInTheDocument();
    await user.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says a closed phone needs Runova open to take files', () => {
    const phone = recipient({
      remoteId: '100000555',
      name: 'Runova app',
      platform: 'android',
      kind: 'phone',
      online: false,
      unavailable: 'offline',
    });
    picker([laptop, phone]);

    const row = screen.getByRole('radio', { name: /Runova app/ });
    expect(row).toBeDisabled();
    expect(within(row).getByText('Open Runova on the phone')).toBeInTheDocument();
  });

  it('finds a device by its name, its owner or its team once there are many', async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      recipient({ remoteId: `10000100${i}`, name: `Desk ${i}` }),
    );
    const { user } = picker([...many, kims]);

    await user.type(screen.getByRole('searchbox', { name: 'Find a device' }), 'ops');

    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Kim's laptop/ })).toBeInTheDocument();
  });

  it('says where devices come from when there are none', () => {
    picker([]);

    expect(screen.getByText(/Your other computers show up here/)).toBeInTheDocument();
  });

  it('says when the website has to be updated first', () => {
    picker([recipient({ unavailable: 'website-outdated' })], null, true);

    expect(screen.getByText(/The Runova website needs an update/)).toBeInTheDocument();
  });
});
