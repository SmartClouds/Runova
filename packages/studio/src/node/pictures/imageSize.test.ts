import { describe, expect, it } from 'vitest';
import { pngHeader } from '../../test/png.js';
import { imageSize } from './imageSize.js';

describe('imageSize', () => {
  it('reads a PNG', () => {
    expect(imageSize(pngHeader(2880, 1800))).toEqual({ width: 2880, height: 1800 });
  });

  it('reads a JPEG past its other markers', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58,
      0x03, 0x20, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600 });
  });

  it('reads an extended WebP', () => {
    const webp = new Uint8Array(30);
    webp.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    );
    webp.set(
      [...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
      8,
    );
    webp.set([0xff, 0x03, 0x00], 24); // width - 1 = 1023
    webp.set([0xff, 0x02, 0x00], 27); // height - 1 = 767
    expect(imageSize(webp)).toEqual({ width: 1024, height: 768 });
  });

  it('says null for anything else', () => {
    expect(imageSize(new TextEncoder().encode('{"probe":{}}'))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
  });
});
