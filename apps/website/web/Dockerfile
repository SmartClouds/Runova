# syntax=docker/dockerfile:1
# The website (docs/epics/40-website.md), built and run with Bun. The build reads the desktop app's
# version and help articles, so the context is the repository root, trimmed by
# Dockerfile.dockerignore next to this file:
#   docker build -f apps/website/web/Dockerfile -t runova-website-web .

FROM oven/bun:1.4.4 AS build
# The repository layout is kept, because the build finds the help articles relative to the site.
WORKDIR /repo/apps/website/web
ARG SITE_URL=https://runovahq.com
ARG PUBLIC_SENTRY_DSN=
ENV SITE_URL=${SITE_URL} \
    PUBLIC_SENTRY_DSN=${PUBLIC_SENTRY_DSN}

COPY apps/website/web/package.json apps/website/web/bun.lock ./
RUN bun install --frozen-lockfile

COPY apps/desktop/package.json /repo/apps/desktop/package.json
COPY apps/desktop/src/shared/help /repo/apps/desktop/src/shared/help
COPY apps/website/web ./
RUN bun run build

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
