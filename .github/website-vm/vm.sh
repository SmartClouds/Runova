#!/usr/bin/env bash
# The Website job's steps call this on the Mac to work in the VM that start.sh created.
#   vm.sh source               copy the checked-out commit to ~/Runova in the VM
#   vm.sh provision            install the toolchain (provision.sh)
#   vm.sh run '<command>'      run a command in apps/website/web, as a step on the Linux runner did
#   vm.sh cache-in <dir>       put Astro's optimized image cache from <dir> into the site
#   vm.sh cache-out <dir>      copy that cache back to <dir>, for actions/cache to save
#   vm.sh reports <dir>        copy test-results and .lighthouseci back to <dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/common.sh"

assets="$VM_WORKDIR/node_modules/.astro/assets"

case "${1:-}" in
  source)
    # Tracked files only, so nothing of the Mac's workspace (node_modules, build output) goes in.
    vm_ssh "rm -rf $VM_REPO && mkdir -p $VM_REPO"
    git -C "${GITHUB_WORKSPACE:-$here/../..}" archive --format=tar HEAD | vm_ssh "tar -x -C $VM_REPO"
    ;;
  provision)
    { echo "export BUN_VERSION=$BUN_VERSION"; cat "$here/provision.sh"; } | vm_script
    ;;
  run)
    shift
    {
      echo 'set -eo pipefail'
      echo '. ~/.runova-ci-env'
      for name in $VM_FORWARDED_ENV; do
        if value=$(printenv "$name"); then printf 'export %s=%q\n' "$name" "$value"; fi
      done
      echo "cd $VM_WORKDIR"
      printf '%s\n' "$*"
    } | vm_script
    ;;
  cache-in)
    if [ -d "$2" ] && [ -n "$(ls -A "$2")" ]; then
      tar -c -C "$2" . | vm_ssh "mkdir -p $assets && tar -x -C $assets"
      echo "Put $(ls "$2" | wc -l | tr -d ' ') cached files into the site."
    else
      echo "No cached images yet; the build encodes them all."
    fi
    ;;
  cache-out)
    rm -rf "$2" && mkdir -p "$2"
    vm_ssh "tar -c -C $assets ." | tar -x -C "$2"
    echo "Copied $(ls "$2" | wc -l | tr -d ' ') cached files out of the VM."
    ;;
  reports)
    mkdir -p "$2"
    # test-results is made when missing, so tar always has something to send.
    vm_ssh "cd $VM_WORKDIR && mkdir -p test-results && tar -c test-results \$(ls -d .lighthouseci 2> /dev/null)" | tar -x -C "$2"
    ;;
  *)
    echo "usage: vm.sh source | provision | run '<command>' | cache-in <dir> | cache-out <dir> | reports <dir>" >&2
    exit 2
    ;;
esac
