/**
 * A reader for the mongosh commands people type, which never runs them as JavaScript. A command
 * becomes a collection (or a database), a chain of method calls, and plain values, with Extended
 * JSON markers ({ $oid }, { $date } and so on) for the shell's helpers. Functions, variables and
 * arithmetic are refused, so nothing typed can do more than the method calls it names.
 */

export interface MongoCall {
  method: string;
  args: unknown[];
}

export type MongoCommand =
  | { kind: 'collection'; database: string | null; collection: string; calls: MongoCall[] }
  | { kind: 'database'; database: string | null; calls: MongoCall[] }
  | { kind: 'show'; what: 'databases' | 'collections' | 'users' | 'roles' }
  | { kind: 'use'; database: string };

const NOT_RUNNABLE =
  'cannot be run here: only plain values (objects, arrays, strings, numbers) and ObjectId, ISODate, NumberLong, NumberDecimal and UUID are read';

class Reader {
  index = 0;

  constructor(readonly text: string) {}

  fail(message: string): never {
    throw new Error(`${message} (at character ${this.index + 1})`);
  }

  space(): void {
    for (;;) {
      const ch = this.text[this.index];
      if (ch === undefined) return;
      if (/\s/.test(ch)) {
        this.index++;
      } else if (ch === '/' && this.text[this.index + 1] === '/') {
        const end = this.text.indexOf('\n', this.index);
        this.index = end < 0 ? this.text.length : end + 1;
      } else if (ch === '/' && this.text[this.index + 1] === '*') {
        const end = this.text.indexOf('*/', this.index + 2);
        this.index = end < 0 ? this.text.length : end + 2;
      } else {
        return;
      }
    }
  }

  peek(): string | undefined {
    this.space();
    return this.text[this.index];
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.index++;
      return true;
    }
    return false;
  }

  expect(ch: string): void {
    if (!this.eat(ch)) this.fail(`Expected "${ch}"`);
  }

  identifier(): string | null {
    this.space();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.index));
    if (!match) return null;
    this.index += match[0].length;
    return match[0];
  }

  string(): string {
    this.space();
    const quote = this.text[this.index];
    if (quote !== '"' && quote !== "'") this.fail('Expected a quoted string');
    this.index++;
    let out = '';
    for (;;) {
      const ch = this.text[this.index];
      if (ch === undefined) this.fail('A string is not closed');
      this.index++;
      if (ch === quote) return out;
      if (ch === '\\') {
        const next = this.text[this.index++];
        const escapes: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          b: '\b',
          f: '\f',
          '0': '\0',
        };
        if (next === 'u') {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('A \\u escape needs four hex digits');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
        } else {
          out += next !== undefined && next in escapes ? (escapes[next] as string) : (next ?? '');
        }
      } else {
        out += ch;
      }
    }
  }

  number(): number {
    this.space();
    const match = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(this.text.slice(this.index));
    if (!match) this.fail('Expected a number');
    this.index += match[0].length;
    return Number(match[0]);
  }

  regex(): { $regularExpression: { pattern: string; options: string } } {
    this.index++;
    let pattern = '';
    let inClass = false;
    for (;;) {
      const ch = this.text[this.index];
      if (ch === undefined || ch === '\n') this.fail('A regular expression is not closed');
      this.index++;
      if (ch === '\\') {
        pattern += ch + (this.text[this.index++] ?? '');
        continue;
      }
      if (ch === '[') inClass = true;
      if (ch === ']') inClass = false;
      if (ch === '/' && !inClass) break;
      pattern += ch;
    }
    const flags = /^[a-z]*/.exec(this.text.slice(this.index))?.[0] ?? '';
    this.index += flags.length;
    return { $regularExpression: { pattern, options: flags.split('').sort().join('') } };
  }

  helper(name: string): unknown {
    this.expect('(');
    const arg = this.peek() === ')' ? undefined : this.value();
    this.expect(')');
    const text = arg === undefined ? undefined : String(arg);
    switch (name) {
      case 'ObjectId':
        if (text === undefined || !/^[0-9a-fA-F]{24}$/.test(text))
          this.fail('ObjectId needs 24 hex characters');
        return { $oid: text.toLowerCase() };
      case 'ISODate':
      case 'Date': {
        const date =
          text === undefined ? new Date() : new Date(typeof arg === 'number' ? arg : text);
        if (Number.isNaN(date.getTime())) this.fail(`"${text}" is not a date`);
        return { $date: date.toISOString() };
      }
      case 'NumberLong':
        if (text === undefined || !/^-?\d+$/.test(text))
          this.fail('NumberLong needs a whole number');
        return { $numberLong: text };
      case 'NumberInt':
        if (text === undefined || !/^-?\d+$/.test(text))
          this.fail('NumberInt needs a whole number');
        return Number(text);
      case 'NumberDecimal':
        if (text === undefined || !/^-?\d+(\.\d+)?$/.test(text))
          this.fail('NumberDecimal needs a number');
        return { $numberDecimal: text };
      case 'UUID':
        if (
          text === undefined ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
        ) {
          this.fail('UUID needs a UUID string');
        }
        return { $uuid: text.toLowerCase() };
      default:
        return this.fail(`${name}(...) ${NOT_RUNNABLE}`);
    }
  }

  value(): unknown {
    const ch = this.peek();
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if (ch === '"' || ch === "'") return this.string();
    if (ch === '/') return this.regex();
    if (ch !== undefined && /[-\d.]/.test(ch)) return this.number();
    const start = this.index;
    const word = this.identifier();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word === 'undefined') return null;
    if (word === 'new') {
      const name = this.identifier();
      if (name !== 'Date') this.fail(`new ${name ?? ''} ${NOT_RUNNABLE}`);
      return this.helper('Date');
    }
    if (word && this.peek() === '(') return this.helper(word);
    this.index = start;
    return this.fail(`"${word ?? ch ?? 'end'}" ${NOT_RUNNABLE}`);
  }

  key(): string {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.string();
    const word = /^[A-Za-z_$][\w$.]*|^\d+/.exec(this.text.slice(this.index))?.[0];
    if (!word) this.fail('Expected a field name');
    this.index += word.length;
    return word;
  }

  object(): Record<string, unknown> {
    this.expect('{');
    const out: Record<string, unknown> = {};
    while (!this.eat('}')) {
      const key = this.key();
      this.expect(':');
      out[key] = this.value();
      if (!this.eat(',')) {
        this.expect('}');
        break;
      }
    }
    return out;
  }

  array(): unknown[] {
    this.expect('[');
    const out: unknown[] = [];
    while (!this.eat(']')) {
      out.push(this.value());
      if (!this.eat(',')) {
        this.expect(']');
        break;
      }
    }
    return out;
  }

  args(): unknown[] {
    this.expect('(');
    const out: unknown[] = [];
    while (!this.eat(')')) {
      out.push(this.value());
      if (!this.eat(',')) {
        this.expect(')');
        break;
      }
    }
    return out;
  }

  done(): void {
    this.eat(';');
    if (this.peek() !== undefined) this.fail('Run one command at a time');
  }
}

/** One value as mongosh would read it, with Extended JSON for the shell's helpers. */
export function parseMongoValue(text: string): unknown {
  const reader: Reader = new Reader(text);
  const value = reader.value();
  if (reader.peek() !== undefined) reader.fail(`What follows the value ${NOT_RUNNABLE}`);
  return value;
}

const SHOW: Record<string, 'databases' | 'collections' | 'users' | 'roles'> = {
  dbs: 'databases',
  databases: 'databases',
  collections: 'collections',
  tables: 'collections',
  users: 'users',
  roles: 'roles',
};

export function parseMongoShell(text: string): MongoCommand {
  const reader: Reader = new Reader(text.trim());
  const start = reader.identifier();
  if (start === 'show') {
    const what = reader.identifier() ?? '';
    const known = SHOW[what];
    if (!known)
      reader.fail(
        `"show ${what}" is not something Runova can show; try show dbs or show collections`,
      );
    reader.done();
    return { kind: 'show', what: known };
  }
  if (start === 'use') {
    const database = /^\s*([^\s;]+)/.exec(reader.text.slice(reader.index))?.[1];
    if (!database) reader.fail('Name the database to use');
    reader.index += reader.text.slice(reader.index).indexOf(database) + database.length;
    reader.done();
    return { kind: 'use', database };
  }
  if (start !== 'db') reader.fail('A command starts with db., show or use');

  let database: string | null = null;
  const path: string[] = [];
  const calls: MongoCall[] = [];
  for (;;) {
    if (reader.eat('[')) {
      path.push(reader.string());
      reader.expect(']');
      continue;
    }
    if (!reader.eat('.')) break;
    const name = reader.identifier();
    if (!name) reader.fail('Expected a name after the dot');
    if (reader.peek() !== '(') {
      if (calls.length > 0) reader.fail(`"${name}" needs to be called, like ${name}()`);
      path.push(name);
      continue;
    }
    if (calls.length === 0 && path.length === 0 && name === 'getSiblingDB') {
      const [value] = reader.args();
      if (typeof value !== 'string') reader.fail('getSiblingDB needs a database name');
      database = value;
      continue;
    }
    if (calls.length === 0 && name === 'getCollection') {
      const [value] = reader.args();
      if (typeof value !== 'string') reader.fail('getCollection needs a collection name');
      path.push(value);
      continue;
    }
    calls.push({ method: name, args: reader.args() });
  }
  if (calls.length === 0) reader.fail('Call a method, like db.orders.find()');
  reader.done();
  return path.length > 0
    ? { kind: 'collection', database, collection: path.join('.'), calls }
    : { kind: 'database', database, calls };
}
