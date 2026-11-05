import type { CliDefinition } from '@runova/core';

/**
 * Turns what a CLI prints in its progress format into lines a person can follow, and picks the
 * final answer out of it. Claude Code's stream-json is one JSON event per line: each tool call,
 * each tool result and each bit of text, then a `result` event with the answer the plain `-p`
 * would have printed. Shown raw it is unreadable, so each event becomes one short line or none.
 */
export interface ProgressDecoder {
  /** The readable lines for one line of the CLI's stdout (often none). */
  lines(raw: string): string[];
  /** The answer, once the CLI has sent it; null until then. */
  answer(): string | null;
}

/** Room for one line in a small log panel; a whole shell script or file body never fits. */
const MAX_DETAIL_CHARS = 160;

function clip(text: string): string {
  const first = text.split('\n').find((line) => line.trim()) ?? '';
  const trimmed = first.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS - 1)}…` : trimmed;
}

/** A path inside the project as the user knows it (`apps/web/package.json`); others stay whole. */
function relative(file: string, cwd: string): string {
  const slashed = file.replace(/\\/g, '/');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (fold(slashed).startsWith(`${fold(root)}/`)) return slashed.slice(root.length + 1);
  return slashed;
}

type Input = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function describeTool(name: string, input: Input, cwd: string): string {
  const file = text(input.file_path) || text(input.notebook_path);
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return file ? `${name} ${relative(file, cwd)}` : name;
    case 'Bash':
    case 'PowerShell':
      return `$ ${clip(text(input.command))}`;
    case 'Grep': {
      const where = text(input.path);
      return `Grep ${clip(text(input.pattern))}${where ? ` in ${relative(where, cwd)}` : ''}`;
    }
    case 'Glob':
      return `Glob ${clip(text(input.pattern))}`;
    default:
      return name;
  }
}

/** A tool result's text, which arrives as a string or as a list of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => text((block as Input)?.text)).join('\n');
}

function claudeStreamJson(cwd: string): ProgressDecoder {
  let answer: string | null = null;
  return {
    lines(raw) {
      let event: Input;
      try {
        event = JSON.parse(raw) as Input;
      } catch {
        // A warning the CLI printed before its events start, say. Worth showing as it is.
        return [raw];
      }
      if (event.type === 'result') {
        answer = text(event.result);
        return [];
      }
      const content = (event.message as Input | undefined)?.content;
      if (!Array.isArray(content)) return [];
      const out: string[] = [];
      for (const block of content as Input[]) {
        if (event.type === 'assistant' && block.type === 'text') {
          out.push(...text(block.text).split('\n'));
        } else if (event.type === 'assistant' && block.type === 'tool_use') {
          const step = describeTool(text(block.name), (block.input as Input) ?? {}, cwd);
          // A shell command carries its own `$`; every other step is marked with `›`.
          out.push(step.startsWith('$ ') ? step : `› ${step}`);
        } else if (event.type === 'user' && block.type === 'tool_result' && block.is_error) {
          // Only failures: a successful result is a whole file or a search dump.
          out.push(`✗ ${clip(resultText(block.content)) || 'The step failed.'}`);
        }
      }
      return out;
    },
    answer: () => answer,
  };
}

/** The decoder for this CLI's progress format, or null for a CLI that prints plain text. */
export function progressDecoderFor(cli: CliDefinition, cwd: string): ProgressDecoder | null {
  return cli.promptProgressFormat === 'claude-stream-json' ? claudeStreamJson(cwd) : null;
}
