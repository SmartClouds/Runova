# syntax=docker/dockerfile:1
# The website (docs/epics/40-website.md), built and run with Bun. The build reads the desktop app's
# version and help articles, so the context is the repository root, trimmed by
# Dockerfile.dockerignore next to this file:
#   docker build -f apps/website/web/Dockerfile -t runova-website-web .

# Astro's cache of optimized images, empty unless the build is given an astro-assets context
# (--build-context astro-assets=<dir>, or additional_contexts in compose). compose.test.yaml passes
# the cache the CI build step just filled, so the image build reuses it instead of encoding every
# screenshot again.
FROM scratch AS astro-assets

FROM oven/bun:1.4.4 AS build
# The repository layout is kept, because the build finds the help articles relative to the site.
WORKDIR /repo/apps/website/web
ARG SITE_URL=https://runovahq.com
ARG PUBLIC_SENTRY_DSN=
ARG SENTRY_ENVIRONMENT=
ARG SENTRY_RELEASE=
ENV SITE_URL=${SITE_URL} \
    PUBLIC_SENTRY_DSN=${PUBLIC_SENTRY_DSN} \
    SENTRY_ENVIRONMENT=${SENTRY_ENVIRONMENT} \
    SENTRY_RELEASE=${SENTRY_RELEASE}

COPY apps/website/web/package.json apps/website/web/bun.lock ./
RUN bun install --frozen-lockfile

COPY apps/desktop/package.json /repo/apps/desktop/package.json
COPY apps/desktop/src/shared/help /repo/apps/desktop/src/shared/help
# The monitoring nodes page shows the node's compose file as it is (E54).
COPY apps/website/monitoring-node/compose.yaml /repo/apps/website/monitoring-node/compose.yaml
COPY apps/website/web ./
# Encoding the screenshots took most of the image build (nearly 10 minutes in CI). Each cached file
# is named by a hash of its source and transform, so a stale one is never reused. The mount is
# writable, but what the build adds to it stays out of the image and out of the given folder.
RUN --mount=type=bind,from=astro-assets,target=/repo/apps/website/web/node_modules/.astro/assets,rw \
    bun run build

# Only what the server needs at run time: no dev tools, no build caches.
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY apps/website/web/package.json apps/website/web/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /repo/apps/website/web/package.json /repo/apps/website/web/tsconfig.json ./
COPY --from=build /repo/apps/website/web/dist ./dist
COPY --from=build /repo/apps/website/web/scripts ./scripts
COPY --from=build /repo/apps/website/web/src ./src
USER bun
EXPOSE 4321
# scripts/server.ts, not the adapter's own server: it adds the security headers to every response.
CMD ["bun", "scripts/server.ts"]
