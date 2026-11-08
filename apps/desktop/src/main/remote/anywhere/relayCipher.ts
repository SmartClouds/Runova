import { createCipheriv, createDecipheriv } from 'node:crypto';
import type { FrameCipher } from './link';

const COUNTER_BYTES = 8;
const TAG_BYTES = 16;

/**
 * Seals every link frame that crosses the website's relay (E62), so the relay passes on bytes it
 * can not read or change. AES-256-GCM with the direction's key from the handshake; a sealed frame
 * is `[counter u64 big-endian][ciphertext][tag]`, and the nonce is four zero bytes then the
 * counter. Each direction has its own key, so a counter is never used twice with one key. The
 * relay is ordered, so a frame must carry exactly the next counter: one played again, dropped or
 * moved is refused and the link closes.
 */
export function createFrameCipher(keys: { send: Uint8Array; receive: Uint8Array }): FrameCipher {
  let sent = 0n;
  let expected = 0n;

  function nonce(counter: bigint): Buffer {
    const out = Buffer.alloc(12);
    out.writeBigUInt64BE(counter, 4);
    return out;
  }

  return {
    seal(frame) {
      const counter = sent++;
      const cipher = createCipheriv('aes-256-gcm', keys.send, nonce(counter));
      const head = Buffer.alloc(COUNTER_BYTES);
      head.writeBigUInt64BE(counter);
      const body = Buffer.concat([cipher.update(frame), cipher.final()]);
      return new Uint8Array(Buffer.concat([head, body, cipher.getAuthTag()]));
    },

    open(sealed) {
      if (sealed.length < COUNTER_BYTES + TAG_BYTES)
        throw new Error('A relay frame too short to open.');
      const data = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
      const counter = data.readBigUInt64BE(0);
      if (counter !== expected) throw new Error('A relay frame out of order, or played again.');
      const decipher = createDecipheriv('aes-256-gcm', keys.receive, nonce(counter));
      decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(data.subarray(COUNTER_BYTES, data.length - TAG_BYTES)),
        decipher.final(),
      ]);
      expected++;
      return new Uint8Array(plain);
    },
  };
}
