import { describe, expect, it } from 'vitest';
import { arrayStrings, inlineString, scanToml, stringValue } from './tomlScan';

describe('scanToml', () => {
  it('reads keys under their tables and skips comments', () => {
    const entries = scanToml(`# top
name = "demo" # trailing

[package]
version = "1.0"
`);
    expect(entries.map((e) => [e.table, e.key, e.text])).toEqual([
      ['', 'name', '"demo"'],
      ['package', 'version', '"1.0"'],
    ]);
  });

  it('keeps a value that spans lines in one piece', () => {
    const [entry] = scanToml(
      '[project]\ndependencies = [\n  "a>=1", # note\n  "b[x]",\n]\nz = 1\n',
    );
    expect(entry.key).toBe('dependencies');
    expect(arrayStrings(entry).map((s) => s.value)).toEqual(['a>=1', 'b[x]']);
  });

  it('understands quoted table names holding brackets and quotes', () => {
    const [entry] = scanToml(
      `[target.'cfg(all(unix, target_arch = "x86"))'.dependencies]\na = "1"\n`,
    );
    expect(entry.table).toBe(`target.'cfg(all(unix, target_arch = "x86"))'.dependencies`);
  });

  it('numbers repeated tables so array-of-table entries can be told apart', () => {
    const entries = scanToml('[[package]]\nname = "a"\n[[package]]\nname = "b"\n');
    expect(entries[0].tableIndex).not.toBe(entries[1].tableIndex);
    expect(entries[0].table).toBe('package');
  });

  it('keeps dotted keys whole and unquotes quoted ones', () => {
    const entries = scanToml('a.workspace = true\n"b" = "1"\n');
    expect(entries.map((e) => e.key)).toEqual(['a.workspace', 'b']);
  });

  it('gives offsets that point at the text in the source', () => {
    const source = '[d]\r\nserde = { version = "1.0", features = ["derive"] }\r\n';
    const [entry] = scanToml(source);
    const version = inlineString(entry, 'version');

    expect(version?.value).toBe('1.0');
    expect(source.slice(version?.start, version?.end)).toBe('1.0');
  });

  it('survives a file that is not really TOML', () => {
    expect(() => scanToml('[broken\n= = =\n"unterminated')).not.toThrow();
  });
});

describe('value helpers', () => {
  it('reads a plain string value', () => {
    const source = 'a = "1.2"\n';
    const value = stringValue(scanToml(source)[0]);
    expect(value?.value).toBe('1.2');
    expect(source.slice(value?.start, value?.end)).toBe('1.2');
  });

  it('is null for a value of another type', () => {
    expect(stringValue(scanToml('a = { b = "1" }\n')[0])).toBeNull();
    expect(inlineString(scanToml('a = "1"\n')[0], 'version')).toBeNull();
  });

  it('reads a dotted field of an inline table', () => {
    const entry = scanToml('a = { module = "x:y", version.ref = "z" }\n')[0];
    expect(inlineString(entry, 'version.ref')?.value).toBe('z');
    expect(inlineString(entry, 'module')?.value).toBe('x:y');
  });

  it('does not take a nested string for an array element', () => {
    const entry = scanToml('dev = [{ include-group = "lint" }, "pytest>=8"]\n')[0];
    expect(arrayStrings(entry).map((s) => s.value)).toEqual(['pytest>=8']);
  });
});
