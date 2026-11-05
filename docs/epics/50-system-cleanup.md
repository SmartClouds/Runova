# E50 Disk Cleanup

Milestone: standalone (Build). Depends on: E49 (the size walk and the progress throttle).

## Goal

Show how much disk space the caches of package managers and developer tools take, and let the
person remove the old versions or everything. A new **Disk Cleanup** page finds each cache (NuGet,
npm, pnpm, Bun, pip, Cargo, Go, pub, Gradle, Playwright, Electron and node-gyp), measures it and
every version in it, and removes what the person picks after one clear confirm. E49 does the same
for the folders inside one project; this is for the caches that live outside every project.

The rule that shapes everything: removal is permanent and a cache can be tens of gigabytes, so the
window never names a path. It names a cache, the scan it came from and item ids, the main process
refuses anything the scan did not report, and every removal passes the safety rules again.

## Tasks

- [x] T1 Version order (`packages/core/src/systemCleanup/versions.ts`): numbers of any length,
  pre-releases ordered the way semver says, a version it cannot read reported as unreadable.
- [x] T2 Layouts and the catalog (`layouts.ts`, `providers.ts`): the folder names each tool writes
  and 15 caches described as data, versioned ones listing what they hold through an injected
  reader, content-addressed ones cleaned only by their tool's command.
- [x] T3 Finding a cache (`locate.ts`, `paths.ts`): environment variable, then the tool's own
  answer for six tools, then the usual folder, on any system, with a pure path helper because the
  package is also bundled into the window.
- [x] T4 Safety (`safety.ts`): drives, home, anything above home, protected and project folders,
  network and device paths, `..`, and a target must be inside its cache and never the cache itself.
- [x] T5 Planning and figures (`plan.ts`, `summary.ts`, `events.ts`): keep the newest N plus the
  newest stable release, leave a package alone if its versions cannot be ordered, "frees up to"
  that leaves out hard-linked bytes, and the scan and clean-up event reducers.
- [x] T6 Engine (`main/systemCleanup/engine`): the directory reader, the byte-counting measure on
  top of E49's `measureTree`, the scanner (two caches at once, layout check, stamps), the removal
  (rename, then delete, links never followed, cancellable) and the cleaner.
- [x] T7 Runtime, sandbox and IPC: one operation at a time, the live scan that a clean-up is
  built from, partial rescans that keep the scan id, leftovers finished off, the e2e sandbox that
  fails closed, a deletion log, and the guarded `systemCleanup` IPC group with strict input.
- [x] T8 Renderer logic: the cards, figures and review as pure functions (`view.ts`), the wording
  of every confirm (`confirm.ts`), the runner and a store that keeps a scan going while the person
  is on another page.
- [x] T9 UI: the hero (invitation, live scan, answer, clean-up progress), the size bar and key,
  the cache cards, the package review with tri-state picks and a bar that carries the size, the
  result notice and the page.
- [x] T10 Help article `disk-cleanup.md`, the menu entry under Build, the startup page and the
  last-page entry.
- [x] T11 e2e on the built app against caches the test builds in a sandbox: scan, clean old
  versions, review, Clear all, cancelling, refused requests, and the page switched off without a
  sandbox.

## Acceptance criteria

- AC1 Disk Cleanup finds the caches that exist on the machine, shows each one's size and what
  could be freed from it, and lists the ones that are not there by name. It never scans on its own;
  the last scan's figures are shown at once and marked as from an earlier scan.
- AC2 A scan shows live progress and can be stopped, and it keeps going while the person looks at
  another page.
- AC3 Clean old versions keeps the newest version of each package (or two or three, as chosen),
  keeps the newest stable release as well, and leaves a package alone when its versions cannot be
  put in order.
- AC4 Review lists each package newest first, starts with the old versions picked, and lets the
  person change any pick. Clear all removes everything in one cache after a confirm that names the
  folder.
- AC5 npm, pnpm, pip, Go's build cache and NuGet's web requests are only ever cleaned by their
  tool's own command, and only when that tool is installed.
- AC6 The confirm says what goes, the most it frees, that it is permanent, what happens when the
  tool wants the files again, and that "newest" is the highest version, not always the one a
  project uses.
- AC7 The window never sends a path. A scan that is not the current one, an item the scan did not
  report, a path in a request or an unknown cache is refused before anything is touched.
- AC8 A folder is set aside under a new name before it is deleted, a link is removed and never
  followed, a folder in use is reported with a reason while the run continues, a folder that
  changed after the scan is left alone, and Cancel stops between steps.
- AC9 A folder that is not laid out like the cache it is claimed to be (a wrong environment
  variable) is shown as not recognised and offers nothing to remove. The home folder, Documents,
  system folders and project folders are never treated as a cache.
- AC10 A test run of the app cannot see or touch real caches: it is switched off unless a sandbox
  folder is given, and then looks only inside it.

## Implementation notes

- The rules are in core so they are tested without a disk and shared with the window. Core is
  bundled into the renderer, where `node:path` does not exist, so it carries its own small path
  helper.
- Sizes are the size of the files (`lstat().size`). Files with more than one name are counted as
  shared and left out of "frees up to".
- Deletion is `rm` after a rename, not the Recycle Bin: a cache of tens of gigabytes would take
  very long to move there and free nothing until the bin was emptied. Every removal is written to
  `logs/disk-cleanup.log` in the app's data folder.
- Tools that start a daemon or download things when run (Gradle, Maven, Flutter, Dart) are never
  run to find a path. Only npm, pnpm, Bun, dotnet, pip and Go are asked, with a timeout, and only
  if they are installed.
- A NuGet folder must hold package files before it is offered, since "folders inside folders" is
  also what an ordinary projects folder looks like.
- The test sandbox sits in the temp folder, which is a protected folder on a real machine. Inside
  a sandbox the protected list is empty and the stricter rule applies: nothing outside the sandbox
  is touched at all.
- Built test-first: core (261 tests), the engine, runtime and IPC (190), and the renderer logic
  and screens (203), then e2e on the built app (6 tests, with the files checked on disk).
- It was also run read-only against a real machine's 15 caches before it was called done. That
  turned up nothing wrong with the layout rules, and it is how the scan time and the event-loop
  figures under Known limits were measured.

## Known limits

- Old-version cleanup needs a cache that stores versions as folders. Content-addressed caches
  (npm, pnpm, pip, Go build) get their tool's command only.
- A project that needs a removed version downloads it again on its next restore. "Newest" is the
  highest version number, which is not always the version a project resolves to (NuGet picks the
  lowest version that fits).
- The scan runs in the main process with a small number of file calls in flight, not in a worker.
  Measured on a developer machine with 15 caches and about 285 GB (a 146 GB NuGet cache and a
  61 GB npm cache among them): 198 seconds from start to finish, an event-loop delay with a mean of
  about 2 ms above the timer's own 10 ms and a 99th percentile of 32 ms, and one stall of 455 ms.
  The page shows live progress and a Stop button meanwhile. If that stall ever matters, the engine
  takes its file system and its emit function as arguments, so it can move into a worker thread
  like the usage scanner without changes to its logic.
- Yarn, Cypress, Puppeteer, uv, Composer, Maven and npm's `_npx` and `_logs` are not covered yet.
  Maven is left out on purpose: `mvn install` puts a person's own libraries in the same folder
  with no remote to restore them from.
- macOS and Linux default folders are covered by unit tests with the system passed in, not by a
  live run on those systems.
