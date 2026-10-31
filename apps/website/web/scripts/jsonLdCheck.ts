// Checks JSON-LD blocks against the schema.org types from schema-dts: each block goes into one
// TypeScript file as a value typed `Graph | WithContext<Thing>`, and the compiler's errors are
// the problems. That catches a misspelled `@type`, a property the type does not have and a value
// of the wrong kind. The SEO build check runs it on every built page and e2e on on-demand pages.
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
const HEADER = "import type { Graph, Thing, WithContext } from 'schema-dts';\n";

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
    source += `export const b${lines.length}: Graph | WithContext<Thing> = ${JSON.stringify(value)};\n`;
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
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    problems.push(`${block.path}: ${message.length > 400 ? `${message.slice(0, 400)}…` : message}`);
  }
  return problems;
}
