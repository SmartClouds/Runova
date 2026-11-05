import { describe, expect, it } from 'vitest';
import { openEnvelopes, sealSecrets } from './envelopes';

const seal = async (plain: string) => ({ mode: 'safeStorage' as const, ciphertext: `c:${plain}` });
const open = async (envelope: { ciphertext: string }) => envelope.ciphertext.slice(2);

describe('openEnvelopes and sealSecrets', () => {
  it('opens every sealed secret, however deep, into a plain marker', async () => {
    const opened = await openEnvelopes(
      {
        host: 'h',
        secretEnvelope: { mode: 'safeStorage', ciphertext: 'c:pw' },
        files: [{ name: '.env', contentEnvelope: { mode: 'safeStorage', ciphertext: 'c:A=1' } }],
      },
      open,
    );

    expect(opened).toEqual({
      host: 'h',
      secretEnvelope: { $secret: 'pw' },
      files: [{ name: '.env', contentEnvelope: { $secret: 'A=1' } }],
    });
  });

  it('seals the markers again on the other computer', async () => {
    const sealed = await sealSecrets(
      {
        host: 'h',
        secretEnvelope: { $secret: 'pw' },
        files: [{ contentEnvelope: { $secret: 'A=1' } }],
      },
      seal,
    );

    expect(sealed).toEqual({
      host: 'h',
      secretEnvelope: { mode: 'safeStorage', ciphertext: 'c:pw' },
      files: [{ contentEnvelope: { mode: 'safeStorage', ciphertext: 'c:A=1' } }],
    });
  });

  it('leaves things that only look a little like envelopes alone', async () => {
    const value = { mode: 'dark', other: { ciphertext: 1 } };

    expect(await openEnvelopes(value, open)).toEqual(value);
  });

  it('says so when a secret can not be opened yet (a locked Servers vault)', async () => {
    await expect(
      openEnvelopes(
        { secretEnvelope: { mode: 'passphrase', iv: 'a', authTag: 'b', ciphertext: 'c' } },
        async () => {
          throw new Error('locked');
        },
      ),
    ).rejects.toThrow('locked');
  });
});
