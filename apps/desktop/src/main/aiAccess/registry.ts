import { z } from 'zod';
import type {
  AiAccessArea,
  AiAccessToolInfo,
  AiApprovalPreview,
  AiCallerKind,
  AiToolRisk,
} from '../../shared/aiAccessTypes';

/**
 * The tools Runova offers an agent over MCP. Each one says which part of the app it belongs to,
 * how risky it is, what its arguments look like (a zod schema, which is also the JSON Schema the
 * agent sees), what the user is shown before allowing it, and what it does.
 */

/** Who is calling and on which project. */
export interface ToolContext {
  /** The project the call is about: the tab's project, the folder the agent runs in, or an argument. */
  projectId: string | null;
  callerKind: AiCallerKind;
  /** The agent's name as the user knows it. */
  agent: string;
  /** The folder the agent runs in, when it said. */
  cwd: string | null;
}

/** What a tool hands back. Text is shown to the agent as is; data is sent as JSON. */
export interface ToolResult {
  text?: string;
  data?: unknown;
}

export interface AiTool<Input = unknown> {
  name: string;
  area: AiAccessArea;
  title: string;
  description: string;
  risk: AiToolRisk;
  input: z.ZodType<Input>;
  /** Refuse the call when there is no project to work on. */
  needsProject?: boolean;
  preview(args: Input, context: ToolContext): AiApprovalPreview | Promise<AiApprovalPreview>;
  run(args: Input, context: ToolContext): Promise<ToolResult>;
}

/** Keeps the argument type flowing from the schema into preview and run. */
export function defineTool<Input>(tool: AiTool<Input>): AiTool<unknown> {
  return tool as unknown as AiTool<unknown>;
}

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean };
}

function inputSchemaOf(tool: AiTool): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<
    string,
    unknown
  >;
  // The input view leaves this out, but an agent should know extra arguments are not read.
  if (schema.type === 'object' && !('additionalProperties' in schema)) {
    schema.additionalProperties = false;
  }
  return schema;
}

export interface ToolRegistry {
  all(): readonly AiTool[];
  get(name: string): AiTool | undefined;
  descriptors(): ToolDescriptor[];
  infos(): AiAccessToolInfo[];
}

export function createToolRegistry(tools: readonly AiTool[]): ToolRegistry {
  const byName = new Map<string, AiTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Two AI access tools are named ${tool.name}.`);
    byName.set(tool.name, tool);
  }
  let descriptors: ToolDescriptor[] | null = null;
  return {
    all: () => tools,
    get: (name) => byName.get(name),
    descriptors() {
      descriptors ??= tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: inputSchemaOf(tool),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.risk === 'read',
          destructiveHint: tool.risk === 'sensitive',
        },
      }));
      return descriptors;
    },
    infos: () =>
      tools.map(({ name, area, title, description, risk }) => ({
        name,
        area,
        title,
        description,
        risk,
      })),
  };
}
