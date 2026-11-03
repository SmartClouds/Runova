# E46 AI access

Milestone: standalone (Agents). Depends on: the hook server (`main/notifications/hookServer.ts`),
the terminal sessions (`main/ipc/terminal.ts`), the per-CLI MCP flags the Relay server uses
(`relayCapabilities().mcp`), and every feature area a tool pack covers.

## Goal

A person tells an AI agent what to do in Runova and the agent does it: "update the staging env
with this file", "add a sample login request to the API Client", "what changed in git". The agent
reaches Runova through Runova's own MCP server. The person decides:

- **Who can connect**: agents in Runova's own tabs, agents in other apps, or both.
- **What runs without asking**: full access, ask before sensitive actions (default), or ask before
  every call, reads included.
- **Where Runova asks**: in a Runova dialog, or in the agent's own CLI session through MCP
  elicitation. If that CLI cannot show questions, Runova falls back to the dialog.

## Design

- **One bridge, tools in the app.** `aiAccess/bridgeScript.ts` writes `runova-app-mcp.cjs`, a stdio
  MCP server with no dependencies. It holds no tools: `tools/list` and every call go to
  `POST /app-mcp/*` on the hook server, so a Runova update changes what agents can do without
  touching the script. The server name is `runova_app`, because `runova` is taken by run proposals
  in project `.mcp.json` files.
- **Bidirectional for the CLI prompt.** When Runova answers a call with `confirm`, the bridge sends
  `elicitation/create` to the client, then posts the answer to `/app-mcp/decide`. The decision runs
  the call Runova held, never new arguments.
- **Who is calling.** Every Runova terminal gets `RUNOVA_AI_ACCESS_KEY`, an HMAC of its session id
  with a secret in `userData/data/ai-access-secret` (`aiAccess/sessionKey.ts`). A call counts as a
  Runova tab only with the right key while that tab is open (`aiAccess/identity.ts`); the session
  id alone is no proof. Everything else is another app.
- **Which project.** An explicit `projectId` argument, else the tab's project, else the project
  whose folder holds the agent's working folder, the deepest one when nested
  (`aiAccess/projectMatch.ts`).
- **Policy** (`aiAccess/policy.ts`): `full` never asks, `sensitive` asks for sensitive tools,
  `all` asks for everything. "Allow for this session" is a grant per bridge process and tool.
- **Approvals** (`aiAccess/approvals.ts`): each is answered once, by the window for dialog
  approvals and only by the bridge that asked for CLI ones. Four minutes without an answer counts
  as a no. Turning AI access off denies what is waiting and drops every grant.
- **Tools** (`aiAccess/registry.ts`, `aiAccess/tools/*.ts`): a name, an area, a risk (`read`,
  `write`, `sensitive`), a zod input (also the JSON Schema the agent sees), a preview for the
  approval and a run function. `toolsContract.test.ts` keeps names, descriptions and risk marks
  honest, and keeps every tool away from the AI access settings.
- **One write path.** A tool calls the same service the IPC handler calls. Where a handler holds
  its logic privately, the tool pack's epic moves it into an exported service first.
- **Live screens.** Every successful non-read call broadcasts `aiAccess:onDataChanged`;
  `useAiAccessDataSync` refetches the queries for that area.
- **Activity** (`aiAccess/audit.ts`): the last 200 calls in `ai-access-activity.json`.
- **Attention.** A new dialog approval while Runova is in the background flashes the window and
  shows an OS notification (`aiAccess/attention.ts`).

## Settings

| Key | Values | Default |
|---|---|---|
| `aiAccessEnabled` | boolean | `false` |
| `aiAccessMode` | `full`, `sensitive`, `all` | `sensitive` |
| `aiAccessPrompt` | `modal`, `cli` | `modal` |
| `aiAccessClients` | `runova`, `both`, `external` | `runova` |
| `aiAccessAttachToTabs` | boolean | `true` |

## IPC

| Channel | Direction | Payload | Returns |
|---|---|---|---|
| `aiAccess:listTools` | renderer to main | none | `AiAccessToolInfo[]` |
| `aiAccess:pendingApprovals` | renderer to main | none | `AiAccessApproval[]` |
| `aiAccess:decide` | renderer to main | `{ id, decision }` | `boolean` |
| `aiAccess:activity` | renderer to main | none | `AiAccessActivityEntry[]` |
| `aiAccess:clearActivity` | renderer to main | none | none |
| `aiAccess:externalStatus` | renderer to main | none | `AiExternalClientStatus[]` |
| `aiAccess:connectExternal` | renderer to main | `'claude' \| 'codex'` | `{ ok, error? }` |
| `aiAccess:disconnectExternal` | renderer to main | `'claude' \| 'codex'` | `{ ok, error? }` |
| `aiAccess:configSnippet` | renderer to main | none | JSON text |
| `aiAccess:launchArgs` | renderer to main | `cliId` | `string[]` |
| `aiAccess:onApprovalsChanged` | main to renderer | `AiAccessApproval[]` | |
| `aiAccess:onActivity` | main to renderer | `AiAccessActivityEntry` | |
| `aiAccess:onDataChanged` | main to renderer | `{ area, projectId }` | |

## Delivery

| Part | Scope | Status |
|---|---|---|
| E46.1 | Engine: settings, policy, approvals, registry, server, bridge, identity, launch flags, IPC | Done |
| E46.2 | Approval dialog, Settings > AI access, live refresh, attention, help article | Done |
| E46.3 | Projects and environments tools | Planned |
| E46.4 | API Client tools | Planned |
| E46.5 | Git and worktrees tools | Planned |
| E46.6 | Docker, scheduled tasks, health, databases | Planned |
| E46.7 | Pipelines, skills, usage, security scans, packages, tests, prompts | Planned |
| E46.8 | Deploy, Cloudflare, SSH and SFTP, remote, vault, studio, error tracking, WordPress, Relay | Planned |

## Limits

- In the CLI prompt mode the answer comes back through the agent's CLI. The Runova dialog is the
  stronger guarantee that the person answered.
- Never exposed as tools: the AI access settings, vault CSV export, backup restore, app update and
  quit.
