---
title: AI Access
category: Agents
order: 35
summary: Let AI agents like Claude Code and Codex work with Runova through its own MCP server, and decide what they may do without asking you.
keywords: ai access, mcp, mcp server, model context protocol, runova_app, agent permissions, approve, approval, allow, deny, full access, ask for sensitive actions, ask for everything, claude code, codex, copilot, connect other apps, env file, api client, database, deploy, vault, git, docker
route: /settings?tab=aiAccess
---

AI access turns Runova into a set of tools an AI agent can use. Instead of opening a project's Environments tab to paste a new `.env` by hand, you can tell the agent "update the staging env with this file", and it makes the change in Runova for you. The same goes for adding a request to the API Client, checking git and more. You decide which agents may connect, how much they may do on their own, and where Runova asks you.

## Where to find it

Open **Settings** and choose **AI access**. Nothing can use Runova until you turn on **Let AI agents use Runova** at the top of that page.

## What agents can work with

- **Projects and environments**: read a project, edit its notes, read and save env files, save one from a file on disk, restore an earlier version.
- **API Client**: collections, folders and requests, and sending a request.
- **Git and worktrees**: status, diffs, history, commits, branches, push, and creating or merging worktrees.
- **Docker, scheduled tasks and healthchecks**: containers and their logs, tasks, and checks.
- **Databases**: saved connections, their tables, and read-only queries. Anything that is not a read is refused before Runova connects.
- **Pipelines, tests, security scans and packages**: why a run failed, running tests, scan reports, outdated packages and updating them.
- **Skills, prompts and blueprints**: installed skills, prompt templates and blueprint steps.
- **Servers**: Deploy apps and websites, Cloudflare DNS, WordPress sites, SSH commands and folders, remote devices and error tracking.
- **Vault, Studio, Relay and usage**: vault entries (a value only when revealed), Studio videos and scenes, the Relay board, and your AI usage.

Some things stay in Runova's own screens because they take several steps or need you: unlocking the vault or the Servers passkey, uploading a new app version, certificates, connecting a WordPress site, writing to a database, rendering a Studio video.

## Who can connect

- **Runova only**: agents running in Runova's own terminal tabs. This is the default.
- **Runova and other apps**: also CLIs you run in your own terminal, and editors with MCP support.
- **Other apps only**: only agents outside Runova.

Runova knows a tab is its own because every terminal it opens carries a private key that other programs do not have. With **Attach to agent tabs Runova opens** on, new Claude Code, Codex and Copilot tabs start with Runova's server already connected, and Claude Code is told not to ask about Runova's tools itself, since Runova asks by your rules. Tabs that were already open keep what they started with.

## What agents may do without asking

- **Full access**: every tool runs without asking. Use it only with agents you trust.
- **Ask for sensitive actions** (recommended): reading and ordinary changes go through. Anything that writes secrets, sends a request, deletes, pushes or touches a server waits for you.
- **Ask for everything**: every call waits for you, reads included.

The **What agents can do** card lists every tool by area, shows whether it is read only, a change or sensitive, and says **Runs** or **Asks** under the mode you picked.

## Where Runova asks

- **In this window**: a Runova dialog names the agent, the project and what it wants. An edit to a file shows a diff. Secret values stay masked until you click **Show values**. **Deny** has the focus, so pressing Enter by accident allows nothing. Press Ctrl+Enter, or Cmd+Enter on a Mac, to allow. Closing the dialog denies the request, and so does leaving it for four minutes. If Runova is in the background, the taskbar icon flashes and a notification appears.
- **In the agent's session**: the question appears in the CLI chat you are already using, with secret values masked. If that CLI cannot show questions, Runova asks in its own window instead and says why.

Both places offer **Allow for this session**, which stops Runova asking again about that tool until the agent restarts.

## Connect other apps

With other apps allowed, the **Connect other apps** card can add Runova to Claude Code and Codex for every project with one click. It uses each CLI's own `mcp add` command, so the CLI keeps owning its settings. For any other app, **Copy config** gives you a standard `mcpServers` block to paste into its MCP settings. An agent outside Runova works on the project whose folder it runs in. It can also name a project itself.

## Recent activity

The **Recent activity** card lists the last calls agents made: which tool, which agent and project, and whether it ran on its own, was approved, denied, timed out or failed. New calls appear as they happen, and **Clear** empties the list.

## What agents can never do

Whatever the mode, no tool can change the AI access settings, so an agent can never give itself more room. No tool exports or imports the vault, restores a backup, changes a server's firewall, updates Runova or quits it. Turning AI access off also forgets every **Allow for this session** and denies anything still waiting.

## Good to know

In the agent's session, the answer comes back through the agent's own CLI. The Runova window is the stronger choice when you want to be sure the answer came from you.
