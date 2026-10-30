import { describe, expect, it } from 'vitest';
import { detectSystem, type SystemSignals, signalsFromHeaders } from '../src/lib/download/detect';

const UA = {
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  windowsFirefox:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  macFirefox:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  ubuntuFirefox: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
  linuxArmFirefox: 'Mozilla/5.0 (X11; Linux aarch64; rv:150.0) Gecko/20100101 Firefox/150.0',
  linux32: 'Mozilla/5.0 (X11; Linux i686; rv:150.0) Gecko/20100101 Firefox/150.0',
  android:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  curl: 'curl/8.10.1',
};

const cases: Array<[string, SystemSignals, ReturnType<typeof detectSystem>]> = [
  // The user agent alone.
  ['Windows Chrome', { userAgent: UA.windowsChrome }, { os: 'windows', arch: 'x64' }],
  ['Windows Firefox', { userAgent: UA.windowsFirefox }, { os: 'windows', arch: 'x64' }],
  ['Windows Edge', { userAgent: UA.windowsEdge }, { os: 'windows', arch: 'x64' }],
  // Every Mac browser says "Intel Mac OS X", Apple silicon too, so the arch stays unknown.
  ['Mac Chrome without hints', { userAgent: UA.macChrome }, { os: 'macos', arch: null }],
  ['Mac Safari', { userAgent: UA.macSafari }, { os: 'macos', arch: null }],
  ['Mac Firefox', { userAgent: UA.macFirefox }, { os: 'macos', arch: null }],
  ['Linux Chrome', { userAgent: UA.linuxChrome }, { os: 'linux', arch: 'x64' }],
  ['Ubuntu Firefox', { userAgent: UA.ubuntuFirefox }, { os: 'linux', arch: 'x64' }],
  ['Linux arm64 Firefox', { userAgent: UA.linuxArmFirefox }, { os: 'linux', arch: 'arm64' }],
  ['32-bit Linux', { userAgent: UA.linux32 }, { os: 'linux', arch: null }],
  // Phones, tablets, ChromeOS and anything else get no desktop default.
  ['Android', { userAgent: UA.android }, { os: null, arch: null }],
  ['iPhone', { userAgent: UA.iphone }, { os: null, arch: null }],
  ['iPad', { userAgent: UA.ipad }, { os: null, arch: null }],
  ['ChromeOS', { userAgent: UA.chromeOs }, { os: null, arch: null }],
  ['curl', { userAgent: UA.curl }, { os: null, arch: null }],
  ['no signals at all', {}, { os: null, arch: null }],
  ['an empty user agent', { userAgent: '' }, { os: null, arch: null }],
  // Client hints come first.
  [
    'Mac Chrome on Apple silicon',
    { userAgent: UA.macChrome, platform: 'macOS', arch: 'arm', bitness: '64' },
    { os: 'macos', arch: 'arm64' },
  ],
  [
    'Mac Chrome on Intel',
    { userAgent: UA.macChrome, platform: 'macOS', arch: 'x86', bitness: '64' },
    { os: 'macos', arch: 'x64' },
  ],
  [
    'Mac Chrome before the arch hint arrives',
    { userAgent: UA.macChrome, platform: 'macOS' },
    { os: 'macos', arch: null },
  ],
  [
    'Windows on Arm (the user agent still says x64)',
    { userAgent: UA.windowsChrome, platform: 'Windows', arch: 'arm', bitness: '64' },
    { os: 'windows', arch: 'arm64' },
  ],
  [
    'Linux Chrome with an arm hint',
    { userAgent: UA.linuxChrome, platform: 'Linux', arch: 'arm', bitness: '64' },
    { os: 'linux', arch: 'arm64' },
  ],
  [
    'the platform hint wins over the user agent',
    { userAgent: UA.windowsChrome, platform: 'Linux' },
    { os: 'linux', arch: 'x64' },
  ],
  [
    'an Android platform hint',
    { userAgent: UA.linuxChrome, platform: 'Android' },
    { os: null, arch: null },
  ],
  [
    'a Chrome OS platform hint',
    { userAgent: UA.linuxChrome, platform: 'Chrome OS' },
    { os: null, arch: null },
  ],
  [
    'an empty platform hint falls back to the user agent',
    { userAgent: UA.linuxChrome, platform: '' },
    { os: 'linux', arch: 'x64' },
  ],
  [
    'an "Unknown" platform hint falls back to the user agent',
    { userAgent: UA.windowsChrome, platform: 'Unknown' },
    { os: 'windows', arch: 'x64' },
  ],
  [
    '32-bit arm',
    { userAgent: UA.linuxChrome, platform: 'Linux', arch: 'arm', bitness: '32' },
    { os: 'linux', arch: null },
  ],
  [
    '32-bit x86',
    { userAgent: UA.linuxChrome, platform: 'Linux', arch: 'x86', bitness: '32' },
    { os: 'linux', arch: null },
  ],
  [
    'an empty arch hint falls back to the user agent',
    { userAgent: UA.linuxArmFirefox, platform: 'Linux', arch: '', bitness: '' },
    { os: 'linux', arch: 'arm64' },
  ],
];

describe('detectSystem', () => {
  it.each(cases)('%s', (_name, signals, expected) => {
    expect(detectSystem(signals)).toEqual(expected);
  });
});

describe('signalsFromHeaders', () => {
  it('reads the user agent and unquotes the client hint headers', () => {
    const headers = new Headers({
      'user-agent': UA.macChrome,
      'sec-ch-ua-platform': '"macOS"',
      'sec-ch-ua-arch': '"arm"',
      'sec-ch-ua-bitness': '"64"',
    });
    expect(signalsFromHeaders(headers)).toEqual({
      userAgent: UA.macChrome,
      platform: 'macOS',
      arch: 'arm',
      bitness: '64',
    });
  });

  it('leaves missing headers out', () => {
    expect(signalsFromHeaders(new Headers({ 'user-agent': UA.curl }))).toEqual({
      userAgent: UA.curl,
      platform: null,
      arch: null,
      bitness: null,
    });
  });

  it('takes a hint value that is not quoted as it is', () => {
    const headers = new Headers({ 'sec-ch-ua-platform': 'Windows' });
    expect(signalsFromHeaders(headers).platform).toBe('Windows');
  });
});
