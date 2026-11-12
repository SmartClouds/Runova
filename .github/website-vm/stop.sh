#!/usr/bin/env bash
# Stops and deletes the job's VM, with the Docker images, volumes and packages inside it, so the
# Mac's disk gets the space back. Runs even when the job failed or was cancelled. The Ubuntu image
# stays in Tart's cache for the next run (Tart prunes that cache itself when the disk runs low).
set -uo pipefail
. "$(dirname "$0")/common.sh"

if ! command -v tart > /dev/null; then
  echo "Tart is not installed, so there is no VM to delete."
  exit 0
fi

before=$(df -k "$HOME" | awk 'NR == 2 { print $4 }')
status=0
for name in $(vm_list_ours); do
  echo "Deleting $name."
  vm_remove "$name" || status=1
done
after=$(df -k "$HOME" | awk 'NR == 2 { print $4 }')
echo "Freed $(( (after - before) / 1024 )) MB, $(( after / 1024 / 1024 )) GB free."
exit "$status"
