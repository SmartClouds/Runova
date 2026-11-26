import { isNode, isScalar, isSeq, LineCounter, parseAllDocuments, visit } from 'yaml';
import { interpolateComposeTree } from './interpolate.js';

/**
 * Reads a compose file into plain data, the way Docker Compose would, without trusting it:
 * one YAML document, at most 1 MB, aliases capped (so a few lines cannot expand into gigabytes),
 * duplicate keys refused, merge keys (`<<`) followed, and no YAML tags other than Compose's own
 * `!reset` (the value is dropped) and `!override` (read as a plain value). With an environment
 * it also substitutes `${...}` the way Compose does; without one the values stay as written.
 *
 * `docker compose config` on the server stays the authority on whether a file is valid Compose.
 * This reader is for what the app shows and decides before it sends anything: the services, the
 * ports they publish, the risks they carry, and the loopback override.
 */

export const MAX_COMPOSE_FILE_BYTES = 1024 * 1024;

/** How many alias expansions a file may need. Real compose files use a handful. */
const MAX_ALIAS_COUNT = 100;

const SERVICE_NAME = /^[a-zA-Z0-9._-]+$/;

const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map(yamlTag));

function yamlTag(name: string): string {
  return `tag:yaml.org,2002:${name}`;
}

export interface ComposeService {
  name: string;
  /** The service's settings, after `!reset` and, when an environment was given, interpolation. */
  definition: Record<string, unknown>;
}

export interface ComposeProject {
  /** The top-level `name`, when the file sets one. The app's own stack name takes precedence. */
  name: string | null;
  /** In the order the file lists them. */
  services: ComposeService[];
  /** The whole file as plain data. */
  data: Record<string, unknown>;
  /** Whether `${...}` was substituted from an environment. */
  interpolated: boolean;
  /** Variables the file uses that the environment does not set. Compose reads them as "". */
  missingVariables: string[];
}

export interface ComposeParseOptions {
  /** Values for `${...}`, usually the stack's rendered environment. */
  environment?: Readonly<Record<string, string>>;
}

export type ComposeParse =
  | { ok: true; project: ComposeProject }
  | {
      ok: false;
      reason: string;
      line?: number;
      /** A required `${NAME:?...}` the environment left unset: the file is fine, a value is missing. */
      unsetVariable?: string;
    };

const refuse = (reason: string, line?: number): ComposeParse =>
  line === undefined ? { ok: false, reason } : { ok: false, reason, line };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The first line of a YAML error, without the code frame that follows it. */
function firstLine(message: string): string {
  return message.split('\n')[0].replace(/:$/, '');
}

export function parseComposeFile(text: string, options: ComposeParseOptions = {}): ComposeParse {
  if (typeof text !== 'string') return refuse('The compose file could not be read as text.');
  if (new TextEncoder().encode(text).length > MAX_COMPOSE_FILE_BYTES) {
    return refuse(`The compose file is larger than ${MAX_COMPOSE_FILE_BYTES / (1024 * 1024)} MB.`);
  }

  const lineCounter = new LineCounter();
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(text, { lineCounter, merge: true, uniqueKeys: true });
  } catch (error) {
    if (error instanceof RangeError)
      return refuse('The compose file is nested too deeply to read.');
    throw error;
  }
  if (documents.length === 0 || (documents.length === 1 && documents[0].contents === null)) {
    return refuse('The compose file is empty.');
  }
  if (documents.length > 1) {
    return refuse(
      `Put the whole compose file in one YAML document; this one has ${documents.length}.`,
    );
  }
  const [document] = documents;
  const lineOf = (node: unknown): number | undefined =>
    isNode(node) && node.range ? lineCounter.linePos(node.range[0]).line : undefined;

  const error = document.errors[0];
  if (error) {
    return refuse(
      `The compose file is not valid YAML: ${firstLine(error.message)}.`,
      error.linePos?.[0].line,
    );
  }

  let problem: { reason: string; line?: number } | null = null as {
    reason: string;
    line?: number;
  } | null;
  visit(document, {
    Pair(_, pair) {
      if (!isScalar(pair.key)) {
        problem = {
          reason: 'The compose file uses a list or a map as a key.',
          line: lineOf(pair.key),
        };
        return visit.BREAK;
      }
    },
    Node(_, node) {
      const { tag } = node;
      if (tag === undefined || tag === '!reset' || tag === '!override' || CORE_TAGS.has(tag))
        return;
      const shown = tag.startsWith(yamlTag('')) ? `!!${tag.slice(yamlTag('').length)}` : tag;
      problem = {
        reason: `The compose file uses the YAML tag ${shown}. Only !reset and !override mean anything to Compose.`,
        line: lineOf(node),
      };
      return visit.BREAK;
    },
  });
  if (problem) return refuse(problem.reason, problem.line);

  // Unknown tags resolve with a warning; the tags were checked above, so only those are let through.
  const warning = document.warnings.find((item) => item.code !== 'TAG_RESOLVE_FAILED');
  if (warning) {
    return refuse(
      `The compose file is not valid YAML: ${firstLine(warning.message)}.`,
      warning.linePos?.[0].line,
    );
  }

  // `!reset` means "as if this were never set", in a map or in a list.
  visit(document, {
    Pair(_, pair) {
      if (isNode(pair.value) && pair.value.tag === '!reset') return visit.REMOVE;
    },
    Node(_, node, path) {
      if (node.tag === '!reset' && isSeq(path[path.length - 1])) return visit.REMOVE;
    },
  });

  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    if (error instanceof ReferenceError && /alias/i.test(error.message)) {
      return refuse(
        'The compose file repeats YAML aliases so many times that reading it could exhaust memory.',
      );
    }
    if (error instanceof RangeError)
      return refuse('The compose file is nested too deeply to read.');
    throw error;
  }
  if (!isRecord(data)) {
    return refuse('The top level of a compose file is a mapping, with services: under it.');
  }

  let interpolated = false;
  let missingVariables: string[] = [];
  const { environment } = options;
  if (environment) {
    const result = interpolateComposeTree(data, (name) =>
      Object.hasOwn(environment, name) ? environment[name] : undefined,
    );
    if (!result.ok) {
      return result.unsetVariable === undefined
        ? refuse(result.reason)
        : { ok: false, reason: result.reason, unsetVariable: result.unsetVariable };
    }
    if (!isRecord(result.value)) return refuse('The compose file could not be interpolated.');
    data = result.value;
    interpolated = true;
    missingVariables = result.missing;
  }

  const record = data as Record<string, unknown>;
  const services: ComposeService[] = [];
  const listed = record.services;
  if (listed !== undefined && listed !== null) {
    if (!isRecord(listed)) {
      return refuse('services: must be a mapping of service names to their settings.');
    }
    for (const [name, definition] of Object.entries(listed)) {
      if (!SERVICE_NAME.test(name)) {
        return refuse(
          `${JSON.stringify(name)} isn't a valid service name. Use letters, digits, dots, dashes and underscores.`,
        );
      }
      if (!isRecord(definition)) {
        return refuse(`The service ${name} needs settings under it, such as image: or build:.`);
      }
      services.push({ name, definition });
    }
  }

  return {
    ok: true,
    project: {
      name: typeof record.name === 'string' ? record.name : null,
      services,
      data: record,
      interpolated,
      missingVariables,
    },
  };
}
