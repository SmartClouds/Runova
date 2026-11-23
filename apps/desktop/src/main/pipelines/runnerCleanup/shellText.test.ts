import { describe, expect, it } from 'vitest';
import { psQuote, shQuote, toBase64, toEncodedCommand } from './shellText';

describe('shQuote', () => {
  it('wraps a plain path in single quotes', () => {
    expect(shQuote('/home/ci/actions-runner')).toBe("'/home/ci/actions-runner'");
  });

  it('keeps a single quote inside from ending the string', () => {
    expect(shQuote("/srv/it's here")).toBe("'/srv/it'\\''s here'");
  });

  it('leaves $, backticks and spaces alone, since single quotes stop all expansion', () => {
    expect(shQuote('/a b/$HOME/`x`')).toBe("'/a b/$HOME/`x`'");
  });
});

describe('psQuote', () => {
  it('doubles a single quote, the only thing a PowerShell literal string treats specially', () => {
    expect(psQuote("C:\\Users\\O'Neil\\runner")).toBe("'C:\\Users\\O''Neil\\runner'");
  });

  it('leaves $ and backticks alone', () => {
    expect(psQuote('C:\\$x`y')).toBe("'C:\\$x`y'");
  });

  it('doubles the curly single quotes too, since PowerShell ends a literal string at them', () => {
    for (const quote of ['\u2018', '\u2019', '\u201A', '\u201B']) {
      expect(psQuote(`C:\\_work\\v${quote};Write-Host hi;${quote}`)).toBe(
        `'C:\\_work\\v${quote}${quote};Write-Host hi;${quote}${quote}'`,
      );
    }
  });
});

describe('toBase64', () => {
  it('encodes UTF-8, so a non-ASCII path survives the trip', () => {
    expect(Buffer.from(toBase64('C:\\Users\\Zoë'), 'base64').toString('utf8')).toBe(
      'C:\\Users\\Zoë',
    );
  });
});

describe('toEncodedCommand', () => {
  it('encodes UTF-16LE the way powershell -EncodedCommand wants it', () => {
    expect(Buffer.from(toEncodedCommand('Write-Output 1'), 'base64').toString('utf16le')).toBe(
      'Write-Output 1',
    );
  });
});
