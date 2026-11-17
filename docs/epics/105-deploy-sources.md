# E105 Deploy sources: registry, GitHub Release, local folder

Milestone: standalone (Deploy). Builds on E07 (compose stacks) and E08 (private registries).

## Goal

The user says where an app's images come from, and only what that source needs leaves the
computer:

- **Docker Registry** (recommended, the default): the images are already in GHCR, Docker Hub or
  another registry. The desktop sends the compose file and the `.env`, plus only the project files
  the compose file itself reads (a mounted `nginx.conf`, an `env_file`, a config or secret file).
  The server pulls with the E08 sign-ins. Nothing builds on the server.
- **GitHub Release**: a CD pipeline builds the image and attaches it to a GitHub Release as a
  `docker save` archive. The server downloads that asset straight from GitHub, checks its size and
  SHA-256 against what GitHub reports, loads it into Docker and deploys. The desktop sends the
  compose file and the `.env` (and the files the compose file reads), never the image.
- **Local Folder**: today's behaviour. The compose folder is packed honouring `.dockerignore` and
  built on the server, but only after the user has seen what will be sent (compressed size, file
  size, file count, largest folders) and approved it.

## Tasks

- [x] T1 Contracts: `StackImageSource` (Registry, GithubRelease, LocalFolder), the source on the
  upload and on the revision info, the release image a revision deploys, the `AwaitingImage`
  state. Columns and migration `StackImageSources`. A revision with no source (an older desktop)
  behaves exactly as before.
- [x] T2 Core: Registry and GitHub Release revisions never build. The override resets `build:` on
  every service (`build: !reset null`), and a service that builds without naming an image makes
  the revision Invalid with the fix.
- [x] T3 Core: `POST /api/v1/stacks/{id}/revisions/{n}/release-image`. Downloads the asset from a
  signed GitHub link the desktop passes (used once, never stored or logged, HTTPS to GitHub's
  asset hosts only) or with the token stored for the repository, checks the size and the SHA-256,
  `docker load`s it and keeps the image names it loaded. Audit `stack.release-image`.
- [x] T4 Core: the pull step leaves out services whose image came from the release.
- [x] T5 Core: GitHub Release access tokens per repository, stored with Data Protection, write-only
  through the hub (Admin and a step-up), with a check against GitHub when saved and a "test
  access" call.
- [x] T6 Core: revise and rollback keep the source and the release image.
- [x] T7 DevHost fakes: `!reset`, pulling named services, loading an image.
- [x] T8 Desktop: the source in the preview and the upload, the project files the compose file
  reads, and why a source cannot deploy a compose file.
- [x] T9 Desktop: GitHub releases of a repository, their image assets with GitHub's digest, and
  the signed link for one asset (through the `gh` sign-in, never written anywhere).
- [x] T10 Desktop: Local Folder packs first and waits for approval with the sizes.
- [x] T11 Renderer: the source choice in the wizard (Docker Registry recommended, GitHub Release,
  Local Folder), the release pickers, the approval step, the new progress phases, and the
  "Give the server access" card.
- [x] T12 Docs: this file, the delivery status, a CD workflow that attaches the image to a release.

## Acceptance criteria

1. A compose file whose images all come from a registry deploys exactly as before E105: no
   archive, the same sign-ins, the same steps. A core from before E105 still deploys it.
2. With Docker Registry or GitHub Release picked, no build runs on the server, even when the
   compose file has `build:` sections, and the only files sent are the compose file, the `.env`
   and the files the compose file reads.
3. A release image whose size or SHA-256 does not match what GitHub reports is refused and never
   reaches Docker. The signed link appears in no log, audit entry, job log, database row or
   answer.
4. Local Folder sends nothing until the user approves the sizes shown.
5. The stored release token cannot be read back through the API and is unreadable without the
   core's Data Protection keys.

## Implementation notes

Server core:

- `StackRevisionRecord` gained `ImageSource` and `ReleaseImage` (JSON), and the `ReleaseTokens`
  table holds the stored tokens (migration `StackImageSources`). A revision whose `ImageSource` is
  null is one from an older desktop and keeps the E07 behaviour: it builds when the compose file
  builds. That is what keeps the existing GHCR workflow unchanged.
- `RevisionShape.NeverBuilds` is set for Registry and GithubRelease. `LoopbackOverride.Render`
  then writes `build: !reset null` for every service that builds, so Compose's own reading has no
  build, `Builds` is false, the build step is skipped and the pull step fetches the image
  instead. The check refuses a building service without `image:` before the override is written.
- `Releases/`: `ReleaseNames` (repository, tag, asset name, SHA-256, token shapes, the asset
  host allowlist: `objects.githubusercontent.com`, `release-assets.githubusercontent.com` and
  `github-production-release-asset-*.s3.amazonaws.com`, HTTPS on the default port only),
  `ReleaseDownloads` (the download: a signed link is used as it is; without one the API describes
  the asset with the stored token or none, a different name, size or digest is refused before the
  download, and the API's redirect is followed by hand without the token), `ReleaseArchive`
  (reads `manifest.json` RepoTags from the archive, gzipped or not, so an archive that holds no
  image the compose file uses is refused before Docker sees it) and `ReleaseTokens` (Data
  Protection purpose `Runova.Releases.Token.v1`).
- The HTTP client has no loggers (`RemoveAllLoggers`) and no automatic redirects, and every
  refusal is the core's own words, so the signed link reaches no log line. The request record
  prints `DownloadUrl = [redacted]`. The download lands in the revision folder as
  `release-image.download` (0600) and is deleted however the request ends.
- `IDockerEngine.LoadImageAsync` streams the archive to `POST /images/load` on the transfers
  client (no request timeout) and returns the names from the `Loaded image:` lines. The pull step
  of a release revision runs `docker compose pull <services>` for the services whose image did
  not come from the release, and skips the pull when none is left.
- Hub: `ListReleaseTokens` and `CheckReleaseAccess` (Operator), `SaveReleaseToken` and
  `DeleteReleaseToken` (Admin and a step-up). A token is stored only once GitHub lists the
  repository's releases with it. Audit `release.token-save` and `release.token-delete`, never
  with the token.

Desktop:

- `previewFromSource` reports `projectFiles` (bind mounts, `env_file`, configs and secrets read
  from the compose folder) and `sourceBlocking` per source. `buildContextTarball({ only })` packs
  just those paths, `.dockerignore` aside. A registry or release deploy refuses project files
  over 5 MB and points at a local deploy, so data folders never go unannounced.
- `DeployStacks.prepareLocal` packs the folder and holds it for 15 minutes under an approval id
  tied to the server, project, compose file and environment; `create` and `upload` with
  `imageSource: 'local'` refuse without that approval and use the archive once.
- `main/deploy/releases/`: releases through `gh api`, the signed link from `gh auth token` and one
  `fetch` with `redirect: 'manual'`, accepted only when it points at a GitHub asset host. The link
  is asked for right before the release image request, goes in its body and nowhere else.
- A core from before E105 answers a revision without `imageSource`; a registry or release deploy
  then stops with "Update this server's Runova core" before anything is deployed.
- Renderer: `ImageSourcePicker`, `ReleasePicker`, `ReleaseAccessCard`, `WhatGoesCard` and
  `LocalApproval`. The progress line reads "The server is checking the files" once every byte of
  an upload is out, rather than sitting at 100% on "Sending".

## A CD workflow that attaches the image to a release

The image is saved under the name the compose file uses as `image:`, so the server can match it.

```yaml
name: Release image
on:
  release:
    types: [published]
permissions:
  contents: write
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build the image
        run: docker build -t acme/shop:${{ github.event.release.tag_name }} .
      - name: Save it as a release asset
        run: docker save acme/shop:${{ github.event.release.tag_name }} | gzip > shop-image.tar.gz
      - name: Attach it to the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release upload "${{ github.event.release.tag_name }}" shop-image.tar.gz --clobber
```

The compose file then names `image: acme/shop:<tag>` (an `${APP_VERSION}` from the environment
works too). GitHub records each asset's SHA-256 when it is uploaded, which is what the server
checks the download against.

## Left

- The release download is covered by the core's tests with a fake GitHub; the DevHost has no
  pretend GitHub, so the e2e run does not drive a release deploy. A system test on a real server
  with a real release is the next step.
- The app page does not show yet which release a revision came from (the revision info carries
  it).
