import { z } from 'zod';
import type { AiAccessSettings } from '../../shared/aiAccessSettings';
import type {
  AiAccessActivityEntry,
  AiAccessDataChange,
  AiActivityOutcome,
  AiApprovalDecision,
  AiCallerKind,
} from '../../shared/aiAccessTypes';
import type { ApprovalBroker } from './approvals';
import { approvalText } from './approvalText';
import { decidePolicy } from './policy';
import type { AiTool, ToolContext, ToolDescriptor, ToolRegistry, ToolResult } from './registry';

/**
 * What Runova does with a tool call from the MCP bridge. In order: refuse while AI access is off
 * or for an agent the user did not let in, find the tool and check the arguments against its
 * schema, work out the project, ask the user when the mode says so (in the window, or in the CLI
 * when the user chose that and the CLI can show it), run the tool, record the call and tell the
 * window what changed. Every answer goes back to the bridge as JSON.
 */

/** What the bridge says about itself on every request. */
export interface CallerHello {
  /** A random id per bridge process: one agent session. */
  connectionId: string;
  sessionId?: string;
  sessionKey?: string;
  cwd?: string;
  clientName?: string;
  canElicit?: boolean;
}

/** Who is calling, worked out from the hello. */
export interface CallerIdentity {
  kind: AiCallerKind;
  agent: string;
  /** The project of the Runova tab the agent runs in. */
  projectId: string | null;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export interface AiAccessServerDeps {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  settings(): Promise<AiAccessSettings>;
  identify(hello: CallerHello): CallerIdentity | Promise<CallerIdentity>;
  findProject(id: string): Promise<ProjectRef | null>;
  projectForFolder(cwd: string): Promise<ProjectRef | null>;
  record(entry: Omit<AiAccessActivityEntry, 'id' | 'at'>): unknown;
  dataChanged(change: AiAccessDataChange): void;
}

export type BridgeAnswer =
  | { ok: true; text?: string; data?: unknown }
  | { ok: true; confirm: { approvalId: string; message: string } }
  | { ok: true; tools: ToolDescriptor[] }
  | { ok: false; error: string };

const helloSchema = z.object({
  connectionId: z.string().min(1).max(128),
  sessionId: z.string().max(128).optional(),
  sessionKey: z.string().max(128).optional(),
  cwd: z.string().max(4096).optional(),
  clientName: z.string().max(200).optional(),
  canElicit: z.boolean().optional(),
});

const callSchema = helloSchema.extend({
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).optional(),
});

const decideSchema = z.object({
  connectionId: z.string().min(1).max(128),
  approvalId: z.string().min(1).max(128),
  decision: z.enum(['allow', 'allow_session', 'deny']),
});

/** What a CLI-side approval needs to run once the user says yes. */
interface HeldCall {
  tool: AiTool;
  args: unknown;
  context: ToolContext;
  project: ProjectRef | null;
}

const OFF_MESSAGE =
  'AI access is turned off in Runova. Ask the user to turn it on in Runova under Settings > AI access.';
const DECLINED_MESSAGE =
  'The user declined this request in Runova. Do not retry it unless they ask you to.';
const TIMEOUT_MESSAGE =
  'Nobody answered the approval in Runova in time, so the request was not carried out.';

function clientsMessage(kind: AiCallerKind): string {
  return kind === 'external'
    ? 'Runova only lets agents in its own terminal tabs use it. The user can change this in Runova under Settings > AI access > Who can connect.'
    : 'Runova only lets agents in other apps use it, not those in its own tabs. The user can change this in Runova under Settings > AI access > Who can connect.';
}

function clientAllowed(clients: AiAccessSettings['clients'], kind: AiCallerKind): boolean {
  return clients === 'both' || (clients === 'runova') === (kind === 'runova');
}

function asAnswer(result: ToolResult): BridgeAnswer {
  return result.data !== undefined
    ? { ok: true, data: result.data }
    : { ok: true, text: result.text ?? 'Done.' };
}

export function createAiAccessServer(deps: AiAccessServerDeps) {
  const held = new Map<string, HeldCall>();

  async function run(
    call: HeldCall,
    outcome: Extract<AiActivityOutcome, 'auto' | 'approved'>,
  ): Promise<BridgeAnswer> {
    const base = recordBase(call);
    try {
      const result = await call.tool.run(call.args, call.context);
      deps.record({ ...base, outcome });
      if (call.tool.risk !== 'read') {
        deps.dataChanged({ area: call.tool.area, projectId: call.context.projectId });
      }
      return asAnswer(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The tool failed.';
      deps.record({ ...base, outcome: 'failed', detail: message });
      return { ok: false, error: message };
    }
  }

  function recordBase(call: HeldCall) {
    return {
      tool: call.tool.name,
      toolTitle: call.tool.title,
      area: call.tool.area,
      risk: call.tool.risk,
      agent: call.context.agent,
      callerKind: call.context.callerKind,
      projectId: call.project?.id ?? null,
      projectName: call.project?.name ?? null,
    };
  }

  function refuse(
    error: string,
    who: { agent: string; kind: AiCallerKind },
    tool: string,
    found?: AiTool,
  ): BridgeAnswer {
    deps.record({
      tool,
      toolTitle: found?.title ?? tool,
      area: found?.area ?? null,
      risk: found?.risk ?? null,
      agent: who.agent,
      callerKind: who.kind,
      projectId: null,
      projectName: null,
      outcome: 'refused',
      detail: error,
    });
    return { ok: false, error };
  }

  async function resolveProject(
    args: unknown,
    identity: CallerIdentity,
    cwd: string | undefined,
  ): Promise<ProjectRef | { error: string } | null> {
    const explicit =
      args &&
      typeof args === 'object' &&
      typeof (args as { projectId?: unknown }).projectId === 'string'
        ? (args as { projectId: string }).projectId
        : null;
    if (explicit) {
      return (
        (await deps.findProject(explicit)) ?? {
          error: `Runova has no project with the id ${explicit}.`,
        }
      );
    }
    if (identity.projectId) {
      const tabProject = await deps.findProject(identity.projectId);
      if (tabProject) return tabProject;
    }
    if (cwd) return deps.projectForFolder(cwd);
    return null;
  }

  async function settle(
    call: HeldCall,
    outcome: Awaited<ReturnType<ApprovalBroker['request']>['decision']>,
  ): Promise<BridgeAnswer> {
    if (outcome === 'allow' || outcome === 'allow_session') return run(call, 'approved');
    deps.record({ ...recordBase(call), outcome: outcome === 'timeout' ? 'timeout' : 'denied' });
    return { ok: false, error: outcome === 'timeout' ? TIMEOUT_MESSAGE : DECLINED_MESSAGE };
  }

  return {
    async tools(body: unknown): Promise<BridgeAnswer> {
      if (!helloSchema.safeParse(body).success) return { ok: false, error: 'Malformed request.' };
      return { ok: true, tools: deps.registry.descriptors() };
    },

    async call(body: unknown): Promise<BridgeAnswer> {
      const parsed = callSchema.safeParse(body);
      if (!parsed.success) return { ok: false, error: 'Malformed request.' };
      const request = parsed.data;
      const [settings, identity] = await Promise.all([deps.settings(), deps.identify(request)]);
      const who = { agent: identity.agent, kind: identity.kind };

      if (!settings.enabled) return refuse(OFF_MESSAGE, who, request.tool);
      if (!clientAllowed(settings.clients, identity.kind)) {
        return refuse(clientsMessage(identity.kind), who, request.tool);
      }
      const tool = deps.registry.get(request.tool);
      if (!tool) return { ok: false, error: `Runova has no tool named ${request.tool}.` };

      const input = tool.input.safeParse(request.args ?? {});
      if (!input.success) {
        return {
          ok: false,
          error: `The arguments do not fit ${tool.name}:\n${z.prettifyError(input.error)}`,
        };
      }

      const project = await resolveProject(input.data, identity, request.cwd);
      if (project && 'error' in project) return { ok: false, error: project.error };
      if (tool.needsProject && !project) {
        return {
          ok: false,
          error:
            'Runova cannot tell which project this is about. Pass projectId (projects_list lists them), or run the agent in the project folder.',
        };
      }

      const call: HeldCall = {
        tool,
        args: input.data,
        project,
        context: {
          projectId: project?.id ?? null,
          callerKind: identity.kind,
          agent: identity.agent,
          cwd: request.cwd ?? null,
        },
      };

      const granted = deps.broker.isGranted(request.connectionId, tool.name);
      if (decidePolicy({ mode: settings.mode, risk: tool.risk, granted }) === 'allow') {
        return run(call, 'auto');
      }

      const preview = await tool.preview(call.args, call.context);
      const inCli = settings.prompt === 'cli' && request.canElicit === true;
      const shown = {
        tool: tool.name,
        toolTitle: tool.title,
        area: tool.area,
        risk: tool.risk,
        agent: identity.agent,
        callerKind: identity.kind,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        preview,
      };
      const { id, decision } = deps.broker.request({
        ...shown,
        connectionId: request.connectionId,
        channel: inCli ? 'cli' : 'modal',
        cliFallback: settings.prompt === 'cli' && !inCli,
        payload: null,
      });

      if (!inCli) return settle(call, await decision);

      held.set(id, call);
      void decision.then((outcome) => {
        if (outcome !== 'timeout' || !held.delete(id)) return;
        deps.record({ ...recordBase(call), outcome: 'timeout' });
      });
      return { ok: true, confirm: { approvalId: id, message: approvalText(shown) } };
    },

    async decide(body: unknown): Promise<BridgeAnswer> {
      const parsed = decideSchema.safeParse(body);
      if (!parsed.success) return { ok: false, error: 'Malformed request.' };
      const { connectionId, approvalId, decision } = parsed.data;
      const call = held.get(approvalId);
      const answered = deps.broker.decide(approvalId, decision as AiApprovalDecision, {
        channel: 'cli',
        connectionId,
      });
      if (!call || !answered) {
        return { ok: false, error: 'That approval is no longer waiting. Make the request again.' };
      }
      held.delete(approvalId);
      return settle(call, decision);
    },
  };
}

export type AiAccessServer = ReturnType<typeof createAiAccessServer>;
