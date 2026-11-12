#!/usr/bin/env bash
# Starts the container a Linux CI job runs its steps in, and points shell.sh at it through
# CI_CONTAINER. stop.sh removes it when the job ends, with every process the steps left running.
#
# The container sees the host the way a step on the host did, so the steps need no changes:
#   - the same paths: the runner user's home (workspace, tool cache, NuGet, Cargo, Gradle), /tmp
#     and the toolchain folders the setup actions name, mounted where they are on the host. A
#     test that bind-mounts a workspace file into a container of its own still names a host path.
#   - the host's network, so a test reaches the containers it starts on localhost, as before.
#   - the host's Docker daemon, through its socket.
#   - the runner's user and groups, so what a step writes stays the runner's to clean up.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if [ "${RUNNER_OS:-}" != "Linux" ]; then
  echo "Only Linux jobs run in a container."
  exit 0
fi

# One job at a time per runner, so the runner's name is enough to tell the containers apart.
name="runova-ci-$(echo "${RUNNER_NAME:-local}" | tr -c 'A-Za-z0-9_.-' '-' | sed 's/-*$//')"
image="runova-ci:$(sha256sum "$here/Dockerfile" | cut -c1-12)"

# A container a cancelled or crashed job of this runner left behind.
docker rm --force "$name" > /dev/null 2>&1 || true

if ! docker image inspect "$image" > /dev/null 2>&1; then
  echo "Building $image."
  docker build --quiet --tag "$image" "$here"
fi
# Images an older Dockerfile made. One the other runner still uses refuses to go, which is fine.
docker image ls --format '{{.Repository}}:{{.Tag}}' runova-ci \
  | grep -vx "$image" | xargs -r docker image rm > /dev/null 2>&1 || true

socket="${DOCKER_HOST:-unix:///var/run/docker.sock}"
socket="${socket#unix://}"

args=(
  --detach --name "$name" --init
  --network host --ipc host
  --volume "$socket:$socket" --env "DOCKER_HOST=unix://$socket"
  # Testcontainers would see /.dockerenv and reach its containers through the bridge gateway. On
  # the host's network they are on localhost, as for a step on the host.
  --env TESTCONTAINERS_HOST_OVERRIDE=localhost
  --volume "$HOME:$HOME" --volume /tmp:/tmp
  --volume /etc/passwd:/etc/passwd:ro --volume /etc/group:/etc/group:ro
  --workdir "${GITHUB_WORKSPACE:-$PWD}"
)

# Rootless Docker maps the container's root to the runner's user, so root is right there. With
# a root daemon, run as the runner's user, in the socket's group so Docker stays reachable.
if docker info --format '{{.SecurityOptions}}' 2> /dev/null | grep -q rootless; then
  echo "Rootless Docker: the steps run as the container's root, which is the runner's user."
else
  args+=(--user "$(id -u):$(id -g)" --group-add "$(stat -c %g "$socket")")
fi

# Toolchains a setup action or the host keeps outside the home folder.
mounted=" $HOME /tmp "
for var in RUNNER_TOOL_CACHE RUNNER_TEMP GITHUB_WORKSPACE JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT \
  DOTNET_ROOT CARGO_HOME RUSTUP_HOME; do
  dir="${!var:-}"
  [ -n "$dir" ] && [ -d "$dir" ] || continue
  case "$dir/" in "$HOME"/* | /tmp/*) continue ;; esac
  case "$mounted" in *" $dir "*) continue ;; esac
  args+=(--volume "$dir:$dir")
  mounted="$mounted$dir "
done

docker run "${args[@]}" "$image" sleep infinity > /dev/null
echo "Steps run in $name ($image)."
echo "CI_CONTAINER=$name" >> "$GITHUB_ENV"
