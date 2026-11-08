import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFrameCipher } from './relayCipher';

const a = randomBytes(32);
const b = randomBytes(32);

/** The two ends of one session: what one sends with, the other receives with. */
function ends() {
  return {
    controller: createFrameCipher({ send: a, receive: b }),
    host: createFrameCipher({ send: b, receive: a }),
  };
}

describe('relay frame cipher', () => {
  it('opens on the other side what this side sealed', () => {
    const { controller, host } = ends();
    const frame = new Uint8Array([1, 2, 3, 4, 5]);

    expect(host.open(controller.seal(frame))).toEqual(frame);
    expect(controller.open(host.seal(frame))).toEqual(frame);
  });

  it('hides the content and changes with every frame', () => {
    const { controller } = ends();
    const frame = new TextEncoder().encode('{"t":"input","event":{"k":"text","text":"hunter2"}}');

    const first = controller.seal(frame);
    const second = controller.seal(frame);

    expect(Buffer.from(first).toString()).not.toContain('hunter2');
    expect(Buffer.from(first)).not.toEqual(Buffer.from(second));
    expect(first.length).toBe(frame.length + 8 + 16);
  });

  it('refuses a frame that was changed on the way', () => {
    const { controller, host } = ends();
    const sealed = controller.seal(new Uint8Array([1, 2, 3]));
    sealed[sealed.length - 1] ^= 1;

    expect(() => host.open(sealed)).toThrow();
  });

  it('refuses a frame played again or out of order', () => {
    const { controller, host } = ends();
    const first = controller.seal(new Uint8Array([1]));
    const second = controller.seal(new Uint8Array([2]));

    expect(() => host.open(second)).toThrow(/order/);
    expect(host.open(first)).toEqual(new Uint8Array([1]));
    expect(() => host.open(first)).toThrow(/order/);
    expect(host.open(second)).toEqual(new Uint8Array([2]));
  });

  it('refuses a frame sealed with the other direction key', () => {
    const { controller } = ends();
    const own = controller.seal(new Uint8Array([1]));

    expect(() => controller.open(own)).toThrow();
  });

  it('refuses a frame too short to carry a counter and a tag', () => {
    const { host } = ends();

    expect(() => host.open(new Uint8Array(10))).toThrow();
  });
});
