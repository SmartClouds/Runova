# E47 Sentry projects and DSNs

Milestone: standalone (Ship). Depends on: E24.

## Goal

Start error tracking for a new app without leaving Runova. From the Errors tab, a person makes a
project in the Sentry organization they connected in E24 and gets its DSN (the address the app
sends its errors to) right away, with the install command and init code for the app's platform
and the DSN already in place. The new project can be linked to a Runova project in the same step,
so its errors show up on the tab. The DSN of a project that is already linked is one click away
too, and an agent can do both through the AI access tools (E46).

## Tasks

- [x] T1 Core (`packages/core/src/errorTracking`): parsers for Sentry teams and client keys (only
  the public DSN is read, never the key's secret), `canCreateProjects` from the token's scopes
  (`project:write` or `project:admin`), the project name rules Sentry applies, and the setup
  snippets for 11 platforms plus Other, each with a link to Sentry's own guide.
- [x] T2 Sentry client and provider: list teams (paged), create a project under a team with a
  JSON POST, list a project's keys. A refusal names `project:write`, and a taken slug shows
  Sentry's own reason.
- [x] T3 Service, IPC and preload: `teams`, `createProject` and `projectKeys`. A new project's keys
  are read once more after a short wait when Sentry has not made the first one yet. The link is
  added next to the project's other links. A refused create or a taken name does not mark the
  connection as broken. Connections and token checks say whether the token can create projects.
- [x] T4 AI access tools: `errors_create_project` (a write, linked to the agent's project unless
  told not to, with the team picked when the organization has one) and `errors_project_keys`.
  Both return the setup snippet with the DSN.
- [x] T5 UI:
  - The New Sentry project dialog: organization when there are several, team, name taken from
    the project it links to, platform, and Link to. A token without `project:write` is stopped
    with Copy scopes and Replace token.
  - The DSN dialog for linked projects.
  - Entry points: New project and Get DSN on the toolbar, Create a Sentry project on the
    nothing-linked states, New Sentry project in the connections dialog, and a key button on
    each linked row.
  - The `project:write` row in the scope checklist.
- [x] T6 e2e against the fake Sentry: connect, create a linked project, see and copy the DSN and
  the snippet, then read the same DSN from the link row; the DSN is not on disk.

## Acceptance criteria

- AC1 With a token that has `project:write`, a project made from the dialog exists in Sentry under
  the chosen team with the chosen platform, its DSN is shown with Copy DSN and Copy as env var,
  and the snippet for the platform holds that DSN.
- AC2 With Link to set, the new project's issues show on the tab without another step, and the
  dialog stays on the DSN while the tab behind it turns into the list.
- AC3 A token known to lack `project:write` cannot start a create, and the dialog says how to fix
  it. One whose scopes are unknown (GlitchTip) may try, and Sentry's refusal is shown as is.
- AC4 No key secret reaches the renderer or an agent, and no DSN is written to disk.

## Implementation notes

- Sentry's API: `GET /api/0/organizations/{org}/teams/` (org:read), `POST
  /api/0/teams/{org}/{team}/projects/` with `{name, platform?}` (project:write), and `GET
  /api/0/projects/{org}/{project}/keys/` (project:read). GlitchTip answers the same paths.
- A DSN is public by design: it only lets an app send events. It is still fetched each time it
  is asked for rather than stored, so a key revoked in Sentry is never shown from a cache.
- The Errors tab renders its dialogs under one key in every state, so a dialog that changes the
  state behind it (the first link) keeps what it was showing.
- Built test-first: core, then client, provider, service, IPC and AI tools, then the renderer,
  then e2e. `errorTracking.e2e.ts` passes 2 of 2 against `e2e/fakeSentryServer.ts`.
