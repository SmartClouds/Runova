#!/usr/bin/env bash
# Creates this run's Linux VM with Tart, boots it headless and waits until SSH answers. Exports
# VM_NAME and VM_IP to the later steps of the job. stop.sh deletes the VM again.
set -euo pipefail
. "$(dirname "$0")/common.sh"

if ! command -v tart > /dev/null; then
  brew install cirruslabs/cli/tart
fi
echo "$(tart --version 2>/dev/null || echo 'tart, version unknown') on $(sw_vers -productName) $(sw_vers -productVersion)"

for stale in $(vm_list_ours); do
  echo "Deleting $stale, left behind by an earlier run."
  vm_remove "$stale"
done

# Half the Mac's memory (at most 12 GB) and all but two of its cores (at most 8), so the Mac and
# the other runner jobs keep room.
host_mb=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
host_cpus=$(sysctl -n hw.ncpu)
vm_mb=$(( host_mb / 2 )); [ "$vm_mb" -gt 12288 ] && vm_mb=12288
vm_cpus=$(( host_cpus - 2 )); [ "$vm_cpus" -gt 8 ] && vm_cpus=8; [ "$vm_cpus" -lt 2 ] && vm_cpus=2
echo "Mac: ${host_mb} MB, ${host_cpus} cores, $(df -h "$HOME" | awk 'NR == 2 { print $4 }') free. VM: ${vm_mb} MB, ${vm_cpus} cores, ${VM_DISK_GB} GB disk."

# The image is pulled once into Tart's cache (~/.tart/cache), and each run clones it.
tart clone "$VM_IMAGE" "$VM_NAME"
tart set "$VM_NAME" --cpu "$vm_cpus" --memory "$vm_mb" --disk-size "$VM_DISK_GB"

log="${RUNNER_TEMP:-/tmp}/$VM_NAME.log"
nohup tart run "$VM_NAME" --no-graphics > "$log" 2>&1 &

ip=""
for _ in $(seq 1 90); do
  if ip=$(tart ip "$VM_NAME" 2> /dev/null) && [ -n "$ip" ]; then break; fi
  ip=""
  sleep 2
done
if [ -z "$ip" ]; then
  echo "::error::The VM got no IP address within 3 minutes."
  cat "$log"
  exit 1
fi
export VM_IP="$ip"

for attempt in $(seq 1 60); do
  if vm_ssh true 2> /dev/null; then break; fi
  if [ "$attempt" -eq 60 ]; then
    echo "::error::SSH on the VM ($ip) did not answer within 2 minutes."
    cat "$log"
    exit 1
  fi
  sleep 2
done
echo "VM $VM_NAME is up at $ip."

if [ -n "${GITHUB_ENV:-}" ]; then
  { echo "VM_NAME=$VM_NAME"; echo "VM_IP=$ip"; } >> "$GITHUB_ENV"
fi
