# E58 Studio pictures: real screenshots, GPT Image, or prompts to make yourself

Milestone: standalone (Studio). Depends on: E32, E33, E35, E38.

## Goal

A video about a project should show the project. Before this, Studio's AI runs could not: every
run happened in Studio's own work folder, was told to change no files, and the scene prompt said
to draw everything and use no outside images. Asking for "run the app and use screenshots of it"
had no way to happen. Image generation existed only as a manual button in the Media list.

Pictures becomes a step of its own between the scenario and the animation: the AI plans what each
scene should show, Studio gets those pictures, and the animator builds each scene around them.

## Design

- **A picture on the scene** (`scenePictureSchema`, `scene.pictures`, optional so older videos
  read as they are): what it shows and why, where it comes from (`screenshot`, `generate` or
  `file`), its state (`planned`, `ready`, `failed`), the shot for a screenshot (a route of the web
  app with optional wait-for selector and click, type, scroll and wait steps, or a desktop app
  window with instructions), the prompt for the others, the file name it has in the scene and in
  the pictures folder, and its media once made. Every change is a `scene.update` edit, so it is in
  the history and undoes like any other.
- **Planning is an AI run** (stage `pictures`, `ai/pictures/prompt.ts` and `answer.ts`). When the
  video belongs to a project the CLI runs in the project's folder, read only (no write flags, no
  trust of the folder), to find the real routes and selectors; the request stays in Studio's work
  folder and a CLI that takes its prompt as an argument is pointed at it by its full path. It is
  told the project's run commands and whether an image model is set up. A plan keeps the pictures
  that are ready and replaces everything else; a generated picture with no image model set up
  becomes the user's file. The AI may also say which run command starts the app and its address,
  which fill in only what the user has not set.
- **Studio takes the screenshots** (`node/pictures/pictureJobs.ts`, desktop
  `main/studio/capture/projectCapture.ts`), not the CLI: it starts the project's run command in its
  folder (or uses an app already answering at the address), reads the address from what the app
  prints, waits until it answers, and opens each route in an offscreen window at 1440x900 (390x844
  for a phone) at 1x or 2x. The window is in a persistent session per project, so "Sign in first"
  keeps a sign-in for later captures; it has no preload and no Node, refuses every permission and
  cannot leave the app's address. The picture is taken once the page has stopped changing. A
  desktop app is captured by its window, after the user brings it to the screen the shot names.
  Studio stops only an app it started, and stops it when the last video of the project closes.
- **GPT Image makes the rest** through E38's jobs and provider calls. One confirmation shows the
  price of all the pictures asked for, and the service refuses unless it is still that price. The
  size follows the video's shape (1536x1024, 1024x1536 or 1024x1024).
- **Or the user makes them**: "Write PICTURES.md" lists every picture still needed with its file
  name, size, what it is for and a prompt ready to paste into any image tool. A file saved in the
  video's `pictures` folder under a listed name (any of PNG, JPEG or WebP) fills its picture, picked
  up as soon as it lands or with "Check the folder".
- **Settings > Agents > Studio > Pictures**: what makes the pictures (GPT Image by default, Gemini,
  or Off), the quality with its price, and the screenshot sharpness.
- **The animator gets them**: a scene run copies the scene's ready pictures into its code tree at
  `pictures/<file name>`, lists them in the request with their size and purpose (framed in a
  browser or device, zoom and pan to what the purpose names, never cropped away), and attaches them
  as images for a CLI that can look at them. A change keeps the tree's pictures and other binary
  files, which before were dropped.
- **Pictures without ffmpeg**: a picture's size is read from its own header, so screenshots,
  generated pictures and dropped files need no ffprobe.

## Tasks

- [x] T1 The picture on the scene, its edits and undo.
- [x] T2 The planning run: prompt, answer, the run in the project folder, read only.
- [x] T3 The app runner and the page and window capture in the desktop host.
- [x] T4 GPT Image for a batch, behind one price confirmation.
- [x] T5 PICTURES.md and the watched pictures folder.
- [x] T6 Pictures in the scene's files and request, kept through a change.
- [x] T7 The Pictures tab, the step bar, the pictures on each scene card, the settings block.
- [x] T8 Tests: the package (plan, capture, generate, folder, animate), the main process (address
  detection, the run command), the renderer (the tab's states, the price confirmation, the step
  bar, the settings).

## Acceptance criteria

- AC1 With a project linked, planning reads the project and names real pages; Studio starts the
  app, captures them and puts each on its scene.
- AC2 A picture the app cannot show is made by GPT Image after one confirmation of the total
  price, or written to PICTURES.md when picture making is off.
- AC3 A file saved under a listed name fills its picture.
- AC4 A scene animated after that has its pictures in its files and in its request.

Status: AC1 to AC4 pass in the package tests against a fake capture host and the fake OpenAI
server; the run command and address detection run against real processes in the main process
tests.

## Known limits

- The address is read from what the app prints, or entered by the user; ports are not read from
  the app's processes.
- No e2e spec drives a real page capture yet; the offscreen capture was tried by hand only.
- Steps can be cleared but not added by hand in the picture editor; asking the AI to plan again
  with a note is the way to change them.
