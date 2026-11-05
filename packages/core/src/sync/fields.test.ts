import { describe, expect, it } from 'vitest';
import { changedFields, type FieldSpec, joinFields, splitFields } from './fields.js';

const project: FieldSpec = {
  device: ['folderPath', 'iconFile', 'wordpress'],
  secret: [],
};

const server: FieldSpec = {
  device: ['privateKeyPath'],
  secret: ['secretEnvelope', 'auth.password'],
};

describe('splitFields', () => {
  it('keeps per-device fields out of what syncs', () => {
    const { shared, device } = splitFields(
      { id: 'p1', name: 'Shop', folderPath: 'C:\\src\\shop', iconFile: 'p1.png' },
      project,
    );

    expect(shared).toEqual({ id: 'p1', name: 'Shop' });
    expect(device).toEqual({ folderPath: 'C:\\src\\shop', iconFile: 'p1.png' });
  });

  it('takes secret fields out, nested ones too, and leaves the rest of the parent', () => {
    const { shared, secret } = splitFields(
      {
        id: 's1',
        host: 'example.com',
        secretEnvelope: { mode: 'safeStorage', ciphertext: 'x' },
        auth: { user: 'root', password: 'hunter2' },
        privateKeyPath: '/home/me/.ssh/id',
      },
      server,
    );

    expect(shared).toEqual({ id: 's1', host: 'example.com', auth: { user: 'root' } });
    expect(secret).toEqual({
      secretEnvelope: { mode: 'safeStorage', ciphertext: 'x' },
      'auth.password': 'hunter2',
    });
  });

  it('does not change the item it was given', () => {
    const item = { id: 's1', auth: { user: 'root', password: 'hunter2' } };

    splitFields(item, server);

    expect(item.auth.password).toBe('hunter2');
  });
});

describe('joinFields', () => {
  it('puts this computer’s own fields back on what came from the other one', () => {
    const joined = joinFields(
      { id: 'p1', name: 'Shop renamed' },
      { secret: {}, device: { folderPath: '/Users/sam/shop' } },
    );

    expect(joined).toEqual({ id: 'p1', name: 'Shop renamed', folderPath: '/Users/sam/shop' });
  });

  it('puts nested secrets back under their parent', () => {
    const joined = joinFields(
      { id: 's1', auth: { user: 'root' } },
      { secret: { 'auth.password': 'hunter2' }, device: {} },
    );

    expect(joined).toEqual({ id: 's1', auth: { user: 'root', password: 'hunter2' } });
  });

  it('round-trips through splitFields', () => {
    const item = {
      id: 's1',
      host: 'h',
      auth: { user: 'root', password: 'p' },
      privateKeyPath: '/k',
      secretEnvelope: { a: 1 },
    };
    const { shared, secret, device } = splitFields(item, server);

    expect(joinFields(shared, { secret, device })).toEqual(item);
  });
});

describe('changedFields', () => {
  it('names the top-level fields that differ, deeply compared', () => {
    expect(
      changedFields(
        { name: 'a', port: 22, tags: ['x'], auth: { user: 'root' } },
        { name: 'b', port: 22, tags: ['x'], auth: { user: 'admin' }, extra: true },
      ),
    ).toEqual(['auth', 'extra', 'name']);
  });
});
