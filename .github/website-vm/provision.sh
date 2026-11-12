#!/usr/bin/env bash
# Runs inside the VM, as admin, after the checkout was copied to ~/Runova. Installs what the
# Linux runner had for the Website job: Docker with Compose and Buildx, Node, pnpm, Bun and the
# .NET SDK, at the versions the repository asks for.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# The image's admin may need its password for sudo. Every later step runs sudo without one.
echo admin | sudo -S -p '' sh -c \
  'echo "admin ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-runova-ci && chmod 440 /etc/sudoers.d/90-runova-ci'

repo="$HOME/Runova"
web="$repo/apps/website/web"

# The cloud image grows its root file system to the disk size at boot. Shown so a full disk is
# easy to tell apart from a test failure.
df -h /
echo "$(nproc) cores, $(free -m | awk '/^Mem:/ { print $2 }') MB memory"

sudo apt-get update -q
# libatomic1: Node's Linux build links against it, and the image leaves it out.
sudo apt-get install -y -q --no-install-recommends \
  ca-certificates curl git unzip xz-utils libatomic1 docker.io docker-compose-v2 docker-buildx
# ICU for the .NET SDK, whose package name carries the Ubuntu release's version (libicu74 on 24.04).
icu=$(apt-cache search --names-only '^libicu[0-9]+$' | awk '{ print $1 }' | sort -V | tail -1)
sudo apt-get install -y -q --no-install-recommends "$icu"
sudo usermod -aG docker admin
sudo systemctl enable --now docker
docker_version=$(sudo docker version --format '{{.Server.Version}}')
echo "Docker $docker_version, $(sudo docker compose version)"

case "$(dpkg --print-architecture)" in
  arm64) node_arch=arm64 ;;
  amd64) node_arch=x64 ;;
  *) echo "Unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;;
esac

# Node 26, the latest release, as the Linux job's setup-node had (check-latest).
node_dist=https://nodejs.org/dist/latest-v26.x
node_file=$(curl -fsSL "$node_dist/SHASUMS256.txt" | awk -v arch="linux-$node_arch.tar.xz" '$2 ~ arch"$" { print $2 }')
curl -fsSL "$node_dist/$node_file" | sudo tar -xJ -C /usr/local --strip-components=1
echo "Node $(node --version)"

# pnpm at the version the root package.json pins (the unit tests ask it about the workspace).
pnpm_version=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$repo/package.json")
sudo npm install -g --silent "pnpm@$pnpm_version"
echo "pnpm $(pnpm --version)"

# BUN_VERSION comes from vm.sh (common.sh), the same Bun the site's Dockerfile builds with.
curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" > /dev/null
echo "Bun $("$HOME/.bun/bin/bun" --version)"

# The SDK that the API's global.json names.
curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --jsonfile "$repo/apps/website/api/global.json" --install-dir "$HOME/.dotnet" > /dev/null
echo ".NET SDK $("$HOME/.dotnet/dotnet" --version)"

# Read by run in vm.sh before every step.
cat > "$HOME/.runova-ci-env" << EOF
export PATH="\$HOME/.bun/bin:\$HOME/.dotnet:\$HOME/.dotnet/tools:\$PATH"
export DOTNET_ROOT="\$HOME/.dotnet"
export DOTNET_NOLOGO=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export ONNXRUNTIME_NODE_INSTALL=skip
EOF
test -d "$web"
