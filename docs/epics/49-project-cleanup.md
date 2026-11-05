# E49 Project cleanup

Milestone: standalone (Build). Depends on: E31 (Studio), E19 to E21 (WordPress projects), E23 (FTP and SFTP sites).

## Goal

Show how much disk space each project takes, and let the person delete the parts it can rebuild.
Every project gets a Cleanup section, and every project on the Projects page shows its size and how
much of it could be freed. The section finds dependencies (`node_modules`, `Pods`, virtual
environments), build output (`dist`, `build`, `.next`, `target` and similar), caches (`.turbo`,
`.gradle`, `coverage` and similar) and the Studio render cache, lets the person tick what to delete,
and deletes it after one clear confirm that names the command that puts each thing back.

The rule that shapes everything: nothing is offered because it is big. Only an allowlist of folder
names is ever offered, only with the file that explains the folder beside it, never when git tracks
it, and the main process runs the same checks again before it deletes anything.

## Tasks

- [x] T1 Rules (`apps/desktop/src/main/projectCleanup/rules.ts`): the allowlist of folder names with
  their category, the marker file that must stand beside each (`package.json`, `Podfile`,
  `pubspec.yaml`, `*.csproj`, `pyvenv.cfg` inside), whether the name is ambiguous, and how the folder
  comes back.
- [x] T2 Size walk and git filter: `measureTree` (bytes, files, newest change, bytes shared with
  other names, never follows a link, survives files vanishing mid-walk, cancellable) and
  `gitFacts` (which folders git tracks or ignores, literal pathspecs, a project that is a
  subfolder of a repository, fails closed).
- [x] T3 Scan: one walk per location that totals everything and sets the rebuildable folders aside
  without entering them, then asks git once, then measures only the ones it will offer. Reads the
  `.git` folder for the totals and never offers it. Restore commands follow the lockfile.
- [x] T4 Service and dependencies: the project folder and each worktree as locations, deploy locks
  (FTP and SFTP local folders, WordPress item folders apart from what a deploy never ships), and a
  removal that takes a location and a folder path, never an absolute path, and re-validates it.
  A deploy lookup that fails locks everything.
- [x] T5 Studio: `cacheUsage` and `clearCache` on the service. Only scene chunks and media
  previews; voice recordings and generated media are never named. A video with a render waiting or
  running is skipped.
- [x] T6 IPC and preload: the `projectCleanup` group (scan, cancel, remove, two event channels),
  answering the main window only, one scan or removal per project at a time, validated input,
  progress events throttled.
- [x] T7 Renderer logic: rows, groups, presets, totals, restore commands and the composition of the
  space (`lib/projectCleanup/selection.ts`), the runner that ties a run to its events and Cancel
  (`runCleanup.ts`), the partial scan built from events (`liveScan.ts`), scanning every project
  (`scanAll.ts`) and the store that keeps summaries between runs.
- [x] T8 UI: the Cleanup section (hero with a count-up and a composition bar, live scanning,
  grouped list with tri-state checkboxes, locked rows with their reason, sticky action bar, confirm,
  per-row progress, failures with Try again), the size chip on every card and row of the Projects
  page, and Check sizes with progress and Stop.
- [x] T9 Help article `project-cleanup.md`, and the Cleanup entry in `projects.md`.
- [x] T10 e2e: scan a seeded project, pick, confirm and delete with the files on disk checked;
  cancelling deletes nothing; the Projects page chip opens Cleanup; forged removal requests sent
  straight to the main process are refused.

## Acceptance criteria

- AC1 The Cleanup section scans a project when it opens and shows what the project uses, how much
  can be freed, and the folders grouped as build output, caches, dependencies and Studio render
  cache, each with its size, file count and age.
- AC2 Build output and caches are ticked by default and dependencies are not. Deleting asks first,
  lists what goes, says it is permanent, and names the command that brings dependencies back.
- AC3 Source, `.env` files, `.git`, `.runova` and agent settings are never offered, and a request
  for any of them, or for a path outside the project, is refused by the main process.
- AC4 A folder git tracks is never offered, and a generic name (`dist`, `out`, `vendor`) is offered
  in a repository only when git ignores it.
- AC5 A folder a deploy keeps in step with a server is shown locked with the reason and cannot be
  picked.
- AC6 Deleting shows each folder as it goes, reports what was freed, keeps a folder that could not
  be deleted with a plain reason and Try again, and the numbers move without scanning again.
- AC7 Studio's voice recordings and generated media are never touched, and a video that is
  rendering is skipped.
- AC8 The Projects page shows each scanned project's size and what could be freed, Check sizes scans
  the projects on screen one after another with Stop, and a project that is removed is forgotten.

## Implementation notes

- Folder sizes are the size of the files (`lstat().size`), not the blocks they occupy. Files with
  more than one name (pnpm's store) are counted as shared and left out of "frees about".
- Deletion is `rm` with retries, not the Recycle Bin: trashing a large `node_modules` on Windows is
  slow, fails on locked files, and frees nothing until the bin is emptied.
- The window never sends a path. It names a location the scan reported and a folder inside it, and
  the service resolves that against the real project and worktree folders, checks the parent with
  `assertPathWithinRoots`, refuses links, and runs the rules, the git check and the deploy locks
  again.
- A scan starts on the next tick after the section mounts, so React's double mount in development
  cancels the first start instead of racing a second scan against it.
- Studio's voice cache holds the person's recordings and `gen` holds generated media, so the
  clear names only `scenes` and `media`.
- Built test-first: rules, size walk, git filter, scan, Studio cache, removal, IPC; then the
  renderer logic, store, components, pages and e2e.
