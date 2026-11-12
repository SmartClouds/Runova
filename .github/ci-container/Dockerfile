# The system the Linux CI jobs run their steps in (see start.sh next to this file). The runner host
# keeps the toolchains (the setup-* actions install them into its tool cache, which the container
# sees at the same path), so this image only carries what those steps used to need from the host:
# the libraries Electron and Chromium link against, Xvfb, ffmpeg, build tools for native modules,
# ICU for .NET, the Docker CLI and the usual command line tools.
#
# start.sh builds it on the runner when this file changes and tags it with a hash of the file.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update -q \
    && apt-get install -y -q --no-install-recommends \
      ca-certificates curl wget gnupg git git-lfs openssh-client \
      tar gzip bzip2 xz-utils zstd zip unzip file \
      procps psmisc iproute2 iputils-ping netcat-openbsd lsof less \
      build-essential pkg-config python3 \
      libicu74 libssl3t64 zlib1g libatomic1 \
      xvfb xauth x11-utils ffmpeg fonts-liberation fonts-dejavu-core \
      libnss3 libnspr4 libgbm1 libdrm2 libxss1 libxtst6 libx11-6 libxcb1 libxext6 libxfixes3 \
      libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 libdbus-1-3 libpango-1.0-0 libcairo2 \
      libwayland-client0 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
      libcups2t64 libglib2.0-0t64 libgtk-3-0t64 \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
    && apt-get update -q \
    && apt-get install -y -q --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*
