// Checks JSON-LD blocks against the schema.org types from schema-dts: each block goes into one
// TypeScript file as typed values, and the compiler's errors are the problems. That catches a
// misspelled `@type`, a property the type does not have and a value of the wrong kind. The SEO
// build check runs it on every built page and e2e on on-demand pages.
//
// Each node is typed as the leaf type its `@type` names (`BlogPostingLeaf` for a BlogPosting)
// rather than as `Thing`. Checking a value against `Thing` makes the compiler resolve nearly every
// type schema.org has, about a second of work, while a leaf type takes a few milliseconds.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface JsonLdBlock {
  /** The page the block is on, used to name it in problems. */
  path: string;
  /** The text inside the `<script type="application/ld+json">` tag. */
  json: string;
}

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const fileName = join(webDir, '__jsonLdCheck__.ts').split('\\').join('/');
const HEADER = "import type * as S from 'schema-dts';\n";
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
// What the compiler says when `S.${type}Leaf` does not exist, so `@type` is not a schema.org type.
const NO_SUCH_TYPE = /no exported member(?: named)? '([A-Za-z0-9]+)Leaf'/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The leaf type `node` names with its `@type`, if it names one. */
function leafType(node: unknown): string | undefined {
  const type = isObject(node) ? node['@type'] : undefined;
  return typeof type === 'string' && TYPE_NAME.test(type) ? `S.${type}Leaf` : undefined;
}

/**
 * Writes the statements that check one block, all on one line. Every node with a `@type`, nested
 * ones too, becomes a constant of its leaf type, and its parent refers to that constant. The
 * parent's property then holds a value of a type its union already lists, which the compiler
 * accepts without comparing it to every member.
 */
class BlockWriter {
  private readonly statements: string[] = [];
  private count = 0;

  constructor(private readonly n: number) {}

  /** The TypeScript expression for `value`, with its typed nodes pulled out into constants. */
  private expression(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.expression(item)).join(',')}]`;
    if (!isObject(value)) return JSON.stringify(value);
    const literal = this.literal(value);
    const type = leafType(value);
    return type ? this.constant(type, literal) : literal;
  }

  private literal(value: Record<string, unknown>): string {
    const entries = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}:${this.expression(item)}`,
    );
    return `{${entries.join(',')}}`;
  }

  private constant(type: string, literal: string): string {
    const name = `b${this.n}_${this.count++}`;
    this.statements.push(`const ${name}: ${type} = ${literal};`);
    return name;
  }

  line(value: unknown): string {
    const root = `b${this.n}`;
    if (isObject(value) && Array.isArray(value['@graph'])) {
      // The graph's nodes on their own, then the envelope with an empty graph.
      for (const node of value['@graph']) this.expression(node);
      const envelope = this.literal({ ...value, '@graph': [] });
      this.statements.push(`export const ${root}: S.Graph = ${envelope};`);
    } else if (isObject(value) && leafType(value)) {
      const literal = this.literal(value);
      this.statements.push(`export const ${root}: S.WithContext<${leafType(value)}> = ${literal};`);
    } else {
      const expression = this.expression(value);
      this.statements.push(
        `export const ${root}: S.Graph | S.WithContext<S.Thing> = ${expression};`,
      );
    }
    return this.statements.join(' ');
  }
}

const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts'],
  types: [],
};

/** Everything wrong with `blocks`, one line each and prefixed with the page; empty when all pass. */
export function jsonLdProblems(blocks: JsonLdBlock[]): string[] {
  const problems: string[] = [];
  // Line n of the source (after the header) holds the block at `lines[n]`.
  const lines: JsonLdBlock[] = [];
  let source = HEADER;
  for (const block of blocks) {
    let value: unknown;
    try {
      value = JSON.parse(block.json);
    } catch (error) {
      problems.push(`${block.path}: the JSON-LD does not parse: ${(error as Error).message}`);
      continue;
    }
    source += `${new BlockWriter(lines.length).line(value)}\n`;
    lines.push(block);
  }
  if (lines.length === 0) return problems;

  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, source, language)
      : getSourceFile(name, language, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? source : readFile(name));

  const program = ts.createProgram([fileName], options, host);
  const file = program.getSourceFile(fileName);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(file),
    ...program.getSemanticDiagnostics(file),
  ];
  const seen = new Set<number>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.file?.fileName !== fileName || diagnostic.start === undefined) {
      problems.push(
        `JSON-LD check: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );
      continue;
    }
    const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line - 1;
    const block = lines[line];
    // One problem per block: the compiler stops at the first mismatch anyway.
    if (!block || seen.has(line)) continue;
    seen.add(line);
    let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    const unknownType = NO_SUCH_TYPE.exec(message);
    if (unknownType) message = `"${unknownType[1]}" is not a schema.org type`;
    problems.push(`${block.path}: ${message.length > 400 ? `${message.slice(0, 400)}…` : message}`);
  }
  return problems;
}
