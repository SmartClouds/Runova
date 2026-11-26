/**
 * Variable substitution the way Docker Compose applies it to compose files (compose-go's
 * template package): `$NAME` and `${NAME}`, the default forms `${NAME:-x}` and `${NAME-x}`,
 * the presence forms `${NAME:+x}` and `${NAME+x}`, the required forms `${NAME:?message}` and
 * `${NAME?message}`, defaults that hold variables of their own, and `$$` for a literal `$`.
 * A `$` not followed by a name or a brace stays as it is; a broken `${...}` is an error, as it is
 * for Compose. Names are case-insensitive letters, digits and underscores.
 */

export type ComposeLookup = (name: string) => string | undefined;

export type ComposeInterpolation<T> =
  | { ok: true; value: T; missing: string[] }
  | {
      ok: false;
      reason: string;
      /** The variable a `${NAME:?...}` or `${NAME?...}` needed and the lookup did not give. */
      unsetVariable?: string;
    };

const NAME = /^[_a-z][_a-z0-9]*/i;

/** What may sit between the braces. Compose's `(.*)` stops at a line break, so this does too. */
const BRACED = /^([_a-z][_a-z0-9]*)(?:(:?[-+?])([^\n]*))?$/i;

/** Defaults inside defaults deeper than this are refused rather than recursed into. */
const MAX_DEPTH = 50;

class TemplateError extends Error {
  constructor(
    message: string,
    /** Set when the error is a required variable with no value. */
    readonly unsetVariable?: string,
  ) {
    super(message);
  }
}

function refusal(error: TemplateError): { ok: false; reason: string; unsetVariable?: string } {
  return error.unsetVariable === undefined
    ? { ok: false, reason: error.message }
    : { ok: false, reason: error.message, unsetVariable: error.unsetVariable };
}

/** One value with its variables substituted, and the names it used that the lookup did not set. */
export function interpolateComposeValue(
  template: string,
  lookup: ComposeLookup,
): ComposeInterpolation<string> {
  const missing = new Set<string>();
  try {
    return { ok: true, value: substitute(template, lookup, missing, 0), missing: [...missing] };
  } catch (error) {
    if (error instanceof TemplateError) return refusal(error);
    throw error;
  }
}

/**
 * Every string value in a parsed compose file, substituted. Keys are left as they are, as
 * Compose leaves them, and so are numbers and booleans.
 */
export function interpolateComposeTree(
  data: unknown,
  lookup: ComposeLookup,
): ComposeInterpolation<unknown> {
  const missing = new Set<string>();
  try {
    return { ok: true, value: walk(data, '', lookup, missing), missing: [...missing] };
  } catch (error) {
    if (error instanceof TemplateError) return refusal(error);
    throw error;
  }
}

function walk(node: unknown, path: string, lookup: ComposeLookup, missing: Set<string>): unknown {
  if (typeof node === 'string') {
    try {
      return substitute(node, lookup, missing, 0);
    } catch (error) {
      if (error instanceof TemplateError && path) {
        throw new TemplateError(`${path}: ${error.message}`, error.unsetVariable);
      }
      throw error;
    }
  }
  if (Array.isArray(node)) {
    return node.map((item, index) => walk(item, `${path}[${index}]`, lookup, missing));
  }
  if (node !== null && typeof node === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // defineProperty, so a "__proto__" key in the file stays an ordinary key.
      Object.defineProperty(copy, key, {
        value: walk(value, path ? `${path}.${key}` : key, lookup, missing),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return node;
}

function substitute(
  template: string,
  lookup: ComposeLookup,
  missing: Set<string>,
  depth: number,
): string {
  if (depth > MAX_DEPTH) throw new TemplateError('Defaults inside ${...} are nested too deeply.');
  let result = '';
  let at = 0;
  while (at < template.length) {
    const dollar = template.indexOf('$', at);
    if (dollar < 0) {
      result += template.slice(at);
      break;
    }
    result += template.slice(at, dollar);
    const next = template[dollar + 1];
    if (next === '$') {
      result += '$';
      at = dollar + 2;
      continue;
    }
    if (next === '{') {
      const close = closingBrace(template, dollar);
      const parts = close < 0 ? null : BRACED.exec(template.slice(dollar + 2, close));
      if (!parts) {
        const shown = template.slice(dollar, close < 0 ? dollar + 40 : close + 1);
        throw new TemplateError(`${JSON.stringify(shown)} isn't a valid \${...} expression.`);
      }
      result += braced(parts, lookup, missing, depth);
      at = close + 1;
      continue;
    }
    const named = NAME.exec(template.slice(dollar + 1));
    if (named) {
      const value = lookup(named[0]);
      if (value === undefined) missing.add(named[0]);
      result += value ?? '';
      at = dollar + 1 + named[0].length;
      continue;
    }
    result += '$';
    at = dollar + 1;
  }
  return result;
}

/**
 * Where the `${` at `from` closes, counted the way compose-go's getFirstBraceClosingIndex counts,
 * so a default may hold `${...}` of its own.
 */
function closingBrace(text: string, from: number): number {
  let open = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '}') {
      open--;
      if (open === 0) return i;
    }
    if (text[i] === '{') {
      open++;
      i++;
    }
  }
  return -1;
}

function braced(
  parts: RegExpExecArray,
  lookup: ComposeLookup,
  missing: Set<string>,
  depth: number,
): string {
  const [, name, operator, rest = ''] = parts;
  const value = lookup(name);
  const inner = () => substitute(rest, lookup, missing, depth + 1);
  switch (operator) {
    case ':-':
      return value !== undefined && value !== '' ? value : inner();
    case '-':
      return value !== undefined ? value : inner();
    case ':+':
      return value !== undefined && value !== '' ? inner() : (value ?? '');
    case '+':
      return value !== undefined ? inner() : '';
    case ':?':
      if (value === undefined || value === '') throw required(name, inner());
      return value;
    case '?':
      if (value === undefined) throw required(name, inner());
      return value;
    default:
      if (value === undefined) missing.add(name);
      return value ?? '';
  }
}

function required(name: string, message: string): TemplateError {
  return new TemplateError(
    message ? `${name} is required: ${message}` : `${name} is required.`,
    name,
  );
}
