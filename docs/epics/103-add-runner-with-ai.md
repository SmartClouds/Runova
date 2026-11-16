# E103 Add a self-hosted runner with AI

Milestone: standalone (Pipelines). Builds on the runners panel (`RunnersPanel.tsx`,
`githubRunners.ts`) and the terminal Ask AI loop (`sshTaskRunner.ts`, E09 and E18).

## Goal

One click has the AI install a GitHub Actions self-hosted runner on this computer or on a saved
server. The user only looks at the runner's name. Everything else (repo, OS, CPU, install folder,
labels, service, runner release, registration token) comes from the machine and the projects.

## Tasks

- [x] T1 Shared name rules (`shared/runnerName.ts`): what GitHub accepts, a name taken on the repo,
  and a name made from a host name or a nickname.
- [x] T2 Main helpers (`main/pipelines/runnerInstall.ts`): the registration token over `gh api` with
  readable refusals, the newest runner release, the package per OS and CPU, the dialog's defaults,
  and the guide the AI follows (folder, download, `config` flags, service per OS).
- [x] T3 Secrets in the AI loop: a run can carry placeholder and value pairs. The value goes into the
  command as it is typed and is masked back out of the transcript, the screen, the progress events
  and the history. A run can also carry a guide that every prompt gets and the history leaves out.
- [x] T4 `startRunnerInstall` (`main/pipelines/runnerInstallTask.ts`): checks the request, fetches
  the token and release, waits for the new tab to be live (30 s) and starts the terminal task.
- [x] T5 IPC: `sshAgent.installRunner` and `pipelines.runnerDefaults`, preload and types.
- [x] T6 Renderer: `startRunnerInstall` in the agent store, `launchRunnerInstall` (opens the tab,
  closes it again on a refusal, links the runner to its machine when the AI finishes).
- [x] T7 UI: `AddRunnerDialog`, an Add runner button on the Runs card and a + on the runners panel.
- [x] T8 Docs: this file, the delivery status and the Pipelines help article.

## Acceptance criteria

1. Add runner is there whenever GitHub is connected, also with no runners yet (the panel is hidden
   then).
2. The dialog opens focused on the name, filled in from this computer or the chosen server, and
   keeps a name the user typed when the machine changes. A name GitHub would refuse, or one a
   runner on the repo already has, is explained under the field and blocks the install.
3. Install with AI opens a terminal tab named after the runner (a local shell or an SSH tab on the
   server) and the AI status bar shows the run. A refusal (no admin rights, gh signed out, the tab
   never connected) closes that tab and shows the reason in the dialog.
4. The registration token is typed into the shell but never appears in a prompt, a progress event,
   the history or the redrawn command line.
5. When the AI finishes, the runner is linked to its machine, the runner list refreshes and a toast
   says it is running.

## Implementation notes

- The token is fetched in main with `gh api --method POST repos/{repo}/actions/runners/registration-token`
  and never crosses IPC. The AI writes `{{RUNOVA_RUNNER_TOKEN}}`; `revealSecrets` swaps it in right
  before the executor and `maskSecrets` swaps it back in the output, the command the screen redraws
  and the password bar. Values shorter than 8 characters are ignored so ordinary text is not masked.
- The history keeps the one-line task ("Install a GitHub Actions self-hosted runner called ...").
  The detailed steps go in the run's guide, so Run again from the history does not carry a stale
  placeholder setup with it.
- This computer gets the exact package name (`actions-runner-<os>-<arch>-<version>`), a server is
  told to check `uname -sm` first. Linux uses `sudo ./svc.sh`, macOS `./svc.sh`, Windows
  `config.cmd --runasservice`, which needs an administrator shell; the AI asks (NEEDS_INPUT) when
  it lacks the rights instead of guessing.
- The link key is the same one the runners panel uses (`owner/repo/name`), so the new tile shows its
  machine's CPU, memory and disk straight away.
- Repo-scoped runners only. Org runners need `admin:org` and a runner group choice, left for later.
