# Runova website

The site at runovahq.com: Astro on bun, with React islands, MDX, Tailwind CSS 4 and shadcn/ui. It
sits outside the pnpm workspace and has its own `bun.lock` and `biome.json`. Specs:
[E40W](../../../docs/epics/40-website.md) and the [design spec](../../../docs/website/design.md).

## Commands

Run these here, or `pnpm website:dev | website:build | website:test | website:e2e` from the root.

| Command                         | What it does                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile` | Installs the pinned dependencies                                                          |
| `bun run dev`                   | Dev server; `/api` and `/media` go to `WEBSITE_API_URL` (default `http://localhost:5180`) |
| `bun run lint`                  | Biome                                                                                     |
| `bun run check`                 | `astro check` (types in `.astro`, `.ts` and `.tsx`)                                       |
| `bun run test`                  | Vitest, with the Astro container API for components                                       |
| `bun run build`                 | Static pages and the server in `dist/`, then `scripts/seoCheck.ts`                        |
| `bun run start`                 | Serves `dist/` with the security headers, `bun scripts/server.ts` (`HOST`, `PORT`)        |
| `bun run e2e`                   | Builds, starts the server under bun and runs Playwright                                   |
| `bun run e2e:stack`             | Playwright against the running compose stack (`e2e/stack/`)                               |
| `bun run lighthouse`            | Lighthouse CI over a local build with the fake API (`lighthouserc.json`)                  |
| `bun run lighthouse:stack`      | Seeds the compose stack, then Lighthouse CI over it (`lighthouserc.stack.json`)           |

`bun run e2e` needs Docker and the .NET SDK: the `admin` Playwright project (`e2e/admin/`) runs
against the real API, which it builds and starts on a PostgreSQL container (`e2e/admin/stack.ts`).

## The compose stack

`../compose.yaml` runs the site the way production does: PostgreSQL 18, the API and the site in
their images (`../api/Dockerfile` and `Dockerfile`, both non-root), and Caddy (`../Caddyfile`)
serving everything on one origin. `/api`, `/hangfire` and the site go to their containers, and
Caddy serves `/media` from the API's media volume. The API migrates the database on start. From
the repository root:

```sh
docker compose -f apps/website/compose.yaml up -d --build --wait
```

The site is then at https://localhost:8443 (Caddy signs the certificate with its own local
authority; http://localhost:8080 redirects there). `HTTP_PORT`, `HTTPS_PORT`, `SITE_URL`,
`SITE_ADDRESS` (a real domain gets a Let's Encrypt certificate), `POSTGRES_PASSWORD`, `VERSION`,
`SENTRY_DSN`, `PUBLIC_SENTRY_DSN` and `GITHUB_TOKEN` change it. The web image builds from the
repository root, since the build reads the desktop app's version and help articles.

`bun run e2e:stack` checks the running stack: one origin, `/hangfire` for Admins, a news item a
signed API client posts showing on `/news`, media at `/media`, and both images running as non-root
with no SDK in the API's. It makes the owner account with `admin create-owner` the first time.
CI runs the same, then Lighthouse, in the `website-web` job.

## Environment

An empty value turns the feature off and breaks nothing.

| Variable                               | Used for                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `SITE_URL`                             | Canonical and Open Graph URLs (default `https://runovahq.com`)           |
| `WEBSITE_API_URL`                      | The dev proxy target                                                     |
| `WEBSITE_API_INTERNAL_URL`             | Server-side API calls: `/download` reads the latest release from it      |
| `PUBLIC_SENTRY_DSN`                    | Sentry; read at build time for the browser and at runtime for the server |
| `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | Sentry environment and release                                           |
| `SENTRY_AUTH_TOKEN`                    | Source map upload during the build, only when set                        |
