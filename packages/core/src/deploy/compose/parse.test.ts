import { describe, expect, it } from 'vitest';
import { type ComposeProject, MAX_COMPOSE_FILE_BYTES, parseComposeFile } from './parse.js';

function project(text: string, environment?: Record<string, string>): ComposeProject {
  const parsed = parseComposeFile(text, { environment });
  if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
  return parsed.project;
}

function refusal(text: string, environment?: Record<string, string>) {
  const parsed = parseComposeFile(text, { environment });
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed;
}

describe('parseComposeFile', () => {
  it('reads the project name and the services in file order', () => {
    const shop = project(
      'name: shop\nservices:\n  web:\n    image: nginx:1.27\n  db:\n    image: postgres:16\n',
    );
    expect(shop.name).toBe('shop');
    expect(shop.services.map((service) => service.name)).toEqual(['web', 'db']);
    expect(shop.services[1].definition).toEqual({ image: 'postgres:16' });
    expect(shop.interpolated).toBe(false);
  });

  it('follows anchors and merge keys, as Compose does', () => {
    const merged = project(
      [
        'x-common: &common',
        '  restart: unless-stopped',
        '  labels: [app]',
        'services:',
        '  web:',
        '    <<: *common',
        '    image: nginx',
      ].join('\n'),
    );
    expect(merged.services[0].definition).toEqual({
      restart: 'unless-stopped',
      labels: ['app'],
      image: 'nginx',
    });
  });

  it('drops values tagged !reset and reads !override as a plain value', () => {
    const tagged = project(
      [
        'services:',
        '  web:',
        '    image: nginx',
        '    ports: !reset []',
        '    dns: [1.1.1.1, !reset 8.8.8.8]',
        '    environment: !override',
        '      A: "1"',
      ].join('\n'),
    );
    expect(tagged.services[0].definition).toEqual({
      image: 'nginx',
      dns: ['1.1.1.1'],
      environment: { A: '1' },
    });
  });

  it('refuses other tags, naming the tag and its line', () => {
    const custom = refusal('services:\n  web:\n    image: !custom nginx\n');
    expect(custom.reason).toMatch(/!custom/);
    expect(custom.line).toBe(3);
    expect(refusal('services:\n  web:\n    image: !!binary aGk=\n').reason).toMatch(/!!binary/);
  });

  it('refuses duplicate keys and broken YAML with the line', () => {
    const duplicate = refusal('services:\n  web:\n    image: a\n    image: b\n');
    expect(duplicate.reason).toMatch(/not valid YAML/);
    expect(duplicate.line).toBe(4);
    const broken = refusal('services:\n  web: [unclosed\n');
    expect(broken.reason).toMatch(/not valid YAML/);
    expect(broken.line).toBeGreaterThan(0);
  });

  it('refuses a file that would blow up when its aliases are expanded', () => {
    const lines = ['a: &a [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
    for (const [name, previous] of [
      ['b', 'a'],
      ['c', 'b'],
      ['d', 'c'],
      ['e', 'd'],
      ['f', 'e'],
      ['g', 'f'],
    ]) {
      lines.push(
        `${name}: &${name} [${Array.from({ length: 9 }, () => `*${previous}`).join(', ')}]`,
      );
    }
    lines.push('services:\n  web:\n    image: nginx\n    labels: *g');
    expect(refusal(lines.join('\n')).reason).toMatch(/aliases/);
  });

  it('refuses files that are not one compose mapping', () => {
    expect(refusal('').reason).toMatch(/empty/);
    expect(refusal('   \n# only a comment\n').reason).toMatch(/empty/);
    expect(refusal('services: {}\n---\nservices: {}\n').reason).toMatch(/one YAML document/);
    expect(refusal('- web\n- db\n').reason).toMatch(/top level/);
    expect(refusal('services: [web, db]\n').reason).toMatch(/services: must be a mapping/);
    expect(refusal('services:\n  web:\n').reason).toMatch(/needs settings/);
    expect(refusal('services:\n  "we b":\n    image: nginx\n').reason).toMatch(/service name/);
    expect(refusal('services:\n  ? [a, b]\n  : image: nginx\n').reason).toMatch(/key/);
    expect(refusal(`x: "${'a'.repeat(MAX_COMPOSE_FILE_BYTES)}"`).reason).toMatch(/1 MB/);
  });

  it('accepts a file without services, such as one made only of include', () => {
    expect(project('include:\n  - other.yaml\n').services).toEqual([]);
  });

  it('keeps a __proto__ key as an ordinary key', () => {
    const odd = project(
      'services:\n  web:\n    image: nginx\n    __proto__:\n      polluted: true\n',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(odd.services[0].definition, '__proto__')).toBe(true);
  });

  it('leaves ${...} as written without an environment', () => {
    const raw = project('services:\n  web:\n    image: nginx:${TAG}\n    ports: ["${PORT}:80"]\n');
    expect(raw.services[0].definition).toEqual({ image: 'nginx:${TAG}', ports: ['${PORT}:80'] });
    expect(raw.missingVariables).toEqual([]);
  });

  it('interpolates with the environment given, listing what it lacked', () => {
    const resolved = project(
      'services:\n  web:\n    image: nginx:${TAG:-1.27}\n    ports: ["${PORT}:80", "${ADMIN}:9000"]\n',
      { PORT: '8080' },
    );
    expect(resolved.interpolated).toBe(true);
    expect(resolved.services[0].definition).toEqual({
      image: 'nginx:1.27',
      ports: ['8080:80', ':9000'],
    });
    expect(resolved.missingVariables).toEqual(['ADMIN']);
    expect(refusal('services:\n  web:\n    image: ${IMAGE:?pick an image}\n', {})).toEqual({
      ok: false,
      reason: 'services.web.image: IMAGE is required: pick an image',
      unsetVariable: 'IMAGE',
    });
  });
});
