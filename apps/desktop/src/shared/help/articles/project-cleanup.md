---
title: Project cleanup
category: Getting started
order: 55
summary: See how much disk space each project takes, and delete the folders it can rebuild (dependencies, build output and caches) to get it back.
keywords: cleanup, clean up, free space, disk space, storage, size, how big, node_modules, dist, build output, cache, delete, reclaim, .next, target, render cache, worktree, check sizes
route: /projects
---

Projects pile up weight that can be made again: `node_modules`, build output, tool caches and the cached pieces of Studio renders. **Cleanup** shows what each project takes up, how much of that you could delete, and deletes the parts you pick. Your own files are never in the list.

## Where to find it

- Open a project and choose **Cleanup** in its list of sections (under **Setup**).
- On the **Projects** page, click the size on a project's card or row. It opens that project on its Cleanup section.
- On the **Projects** page, click **Check sizes** to scan every project in turn, so each card can show its size.

## What you see

The top of the section shows **Can be freed**, the amount you could get back, and how much the project uses in all. Under it, a bar and a list show where the space goes: your files, git history, dependencies, build output, caches and the Studio render cache. Each part is named with its size, so you never have to read the bar by colour.

Below that, the folders it found are grouped by how they come back:

- **Build output** (`dist`, `build`, `out`, `.next`, `target` and similar) comes back the next time you build.
- **Caches** (`.turbo`, `.cache`, `.gradle`, `coverage` and similar) are filled again by the tools that use them.
- **Dependencies** (`node_modules`, `Pods`, a Python virtual environment) come back when you reinstall them. Each one shows the command, such as `pnpm install`, that puts it back.
- **Studio render cache** holds the previews and render pieces of the project's videos.

Each folder shows its size, how many files it holds and how long ago anything in it changed.

## Delete what you pick

1. Tick the folders you want gone. The checkbox on a group picks all of it. **Safe pick** ticks build output, caches and the Studio render cache, and leaves dependencies alone because they take a while to install again. **Select all** and **Select none** do what they say.
2. A bar appears at the bottom with how many items you picked and how much that frees. Click **Delete** with the size on it.
3. A window lists what will go and the command that brings the dependencies back. Click **Delete** to confirm.

Deleted folders do not go to the Recycle Bin or Trash. A large `node_modules` can take a long time to move there and would not free the space until you emptied it. Each row shows when it is being deleted and what it freed. If a folder cannot be deleted, usually because a dev server or terminal is using it, the row says why and offers **Try again** once you have stopped it.

## What it never touches

Cleanup only offers folders from a short list of names, and only when the file that explains the folder is beside it (a `package.json` next to `node_modules`, for example). It never offers your source, `.env` files, the `.git` folder, Runova's own `.runova` folder or agent settings. A folder that git tracks is left alone, and a generic name like `dist` or `out` is offered in a git repository only when git ignores it. The same checks run again in the app before anything is deleted.

Studio keeps your videos, voice recordings and generated media. Only the render pieces and media previews can be cleared, and a video that is rendering is skipped.

## Locked folders

A folder that an FTP or SFTP deploy site keeps in step with a server is shown with a lock and cannot be picked, because deleting it here would be read as a delete on the server at the next deploy. The same goes for the files of a WordPress theme or plugin you deploy, apart from the folders that a deploy never sends, such as `node_modules`.

## Worktrees

A project's worktrees are scanned too, since each one has its own `node_modules` and build output. Their folders appear in the same list with the branch name next to them, and they are counted once.

## When a number looks different from Explorer or Finder

Sizes are the size of the files, not the space the disk sets aside for them, so a folder of many small files can look smaller here. A `node_modules` made by pnpm shares files with pnpm's store, so deleting it frees less than its size. Those rows say **frees about** and the smaller figure.

See also [Projects](projects.md#cleanup), [Worktrees](worktrees.md) and [Studio](studio.md).
