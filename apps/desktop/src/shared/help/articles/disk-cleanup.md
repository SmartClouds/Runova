---
title: Disk Cleanup
category: Build
order: 50
summary: Find the caches your package managers and developer tools keep (NuGet, npm, pnpm, Bun, Cargo, Gradle and more), see how much space each takes, and remove old versions or everything.
keywords: disk cleanup, clean up, free space, disk space, cache, caches, nuget, npm, pnpm, bun, cargo, go, gradle, pub, flutter, playwright, electron, node-gyp, pip, package manager, old versions, newest, delete, reclaim, storage
route: /cleanup
---

Package managers and developer tools save what they download so the next install is fast, and they rarely clear it out. Over time that adds up: old versions of the same package, browsers for tests you no longer run, Gradle versions from projects you finished. **Disk Cleanup** finds those caches, shows how much space each one takes, and removes the old versions or the whole cache. It only looks at caches that tools download again. Your projects, your source and your settings are not part of it.

## Where to find it

Open **Disk Cleanup** in the main menu, under **Build**. To clean the folders inside one project (`node_modules`, build output), use [Project cleanup](project-cleanup.md) instead.

## What it looks at

- **NuGet** packages, and NuGet's saved web requests
- **npm**, **pnpm**, **Bun** and **pip**
- **Cargo** crates
- **Go** modules and the Go build cache
- **Dart and Flutter** packages (pub)
- **Gradle** distributions and Gradle caches
- **Playwright** browsers, **Electron** downloads and **node-gyp** headers

It finds each cache the way the tool does: the environment variable that moves it, then the tool's own answer for a few of them, then the usual folder. A cache that is not on your computer is listed at the bottom as not found.

## Scan

Reading a large cache takes time, so Disk Cleanup never scans on its own. Click **Find caches**. The top of the page counts up what it has found so far, and each card shows its own progress. You can click **Stop** at any time. You can leave the page while it runs and come back.

After a scan the page shows **Can be freed**, the most you could get back by removing old versions, a bar and a list of where the space goes, and how much of your disk the caches use. Next time you open the page, it shows the figures from the last scan and says so. A cache from an earlier scan is read again, just that one, before anything is done to it.

## Clean old versions

Caches such as NuGet, Bun, Cargo and Gradle keep one folder for every version of every package. **Clean old versions** keeps the newest version of each package and removes the rest. Use **Keep newest** to keep two or three instead.

Some details worth knowing:

- Pre-releases are understood: `10.0.0-rc.1` is older than `10.0.0`. If a newer pre-release would push the latest stable version out, the stable one is kept as well.
- If a package has a version that cannot be put in order, the whole package is left alone and the result says so.
- A package with only one version is never touched.

To see exactly what will go, click **Review** on a card. It lists each package, newest version first. The old versions are already ticked and the newest is marked **Newest, kept**. Tick or untick any version, search for a package, and click **Delete** with the size on it.

## Clear all

**Clear all** removes everything in a cache. It asks first and names the folder. Use it for a cache you do not need, or when you want it rebuilt from scratch.

## Caches only their tool cleans

npm, pnpm, pip, Go's build cache and NuGet's web requests are stored in a way only the tool itself understands, with no folder per version. Disk Cleanup measures them and cleans them by running the tool's own command, such as `npm cache clean --force` or `pnpm store prune`, after you confirm. If the tool is not installed, the card says so. pnpm's store is shared with your projects, so its command removes only what nothing uses any more.

## What happens when you delete

Removal is permanent. It does not go to the Recycle Bin or Trash, because a cache can be tens of gigabytes and the bin would not free the space until you emptied it. The confirmation says what goes, the most it can free, and what happens the next time a tool wants the files. Every removal is also written to a log in the app's data folder.

- Close running builds and dev servers first. A folder that is in use is skipped, the result says why, and the rest carries on. Click **Try again** after you close whatever has it.
- A folder that changed after the scan is left alone, because a tool may have started using it.
- Cancelling stops between items. What was already removed stays removed.

## Things to know

- **Old is not always unused.** "Newest" means the highest version number. A project that still needs an older version downloads it again the next time it restores. That costs time and a download, and nothing is lost.
- **Frees up to.** Some files are shared (hard links), so deleting one copy does not free them. Those are left out of the figure, and the confirmation says "frees up to".
- **Sizes differ from Explorer or Finder.** The page adds up the size of the files, not the space the disk sets aside for them.
- **A folder it does not recognise is not offered.** If a cache location points at a folder that is not laid out like that tool's cache, the card says **Not recognised** and nothing in it can be removed.
- **It never touches** your home folder, Documents, Downloads, system folders or a project folder.

See also [Project cleanup](project-cleanup.md).
