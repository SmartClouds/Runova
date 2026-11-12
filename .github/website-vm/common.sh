# Shared by the scripts that run the Website CI job in a Tart Linux VM on the Mac mini (see the
# website-web job in .github/workflows/ci.yml). Sourced, not run.

# One VM per run attempt, so a rerun never meets the VM of the attempt before it.
VM_NAME="${VM_NAME:-runova-website-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"
VM_PREFIX=runova-website-
# Cirrus Labs' Ubuntu image for Tart (arm64). Its user is admin, password admin. The VM sits on
# Tart's host-only NAT network, so only this Mac can reach it.
VM_IMAGE="${VM_IMAGE:-ghcr.io/cirruslabs/ubuntu:latest}"
VM_DISK_GB="${VM_DISK_GB:-60}"
# The Bun the site's Dockerfile uses (oven/bun:1.4.4).
BUN_VERSION=1.4.4

# The checkout inside the VM. Steps run in the site's folder, as they did on the Linux runner.
VM_REPO='~/Runova'
VM_WORKDIR='~/Runova/apps/website/web'

# Job environment the steps read inside the VM (vm.sh passes on the ones that are set).
VM_FORWARDED_ENV="CI GITHUB_ACTIONS GITHUB_SHA COMPOSE_PROJECT_NAME HTTP_PORT HTTPS_PORT STACK_URL STACK_HTTP_URL SITE_URL"

# SSH with the image's password, given by SSH_ASKPASS so nothing has to be installed on the Mac
# (OpenSSH 8.4+ honours SSH_ASKPASS_REQUIRE). Host keys are not kept: each VM is new.
vm_askpass() {
  local askpass="${RUNNER_TEMP:-/tmp}/website-vm-askpass"
  if [ ! -x "$askpass" ]; then
    printf '#!/bin/sh\necho admin\n' > "$askpass"
    chmod 700 "$askpass"
  fi
  echo "$askpass"
}

vm_ip() {
  if [ -n "${VM_IP:-}" ]; then
    echo "$VM_IP"
  else
    tart ip "$VM_NAME"
  fi
}

vm_ssh() {
  SSH_ASKPASS="$(vm_askpass)" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-:0}" ssh \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 \
    "admin@$(vm_ip)" "$@"
}

# Runs the bash script on stdin inside the VM. The script is written to a file there first, so a
# command in it that reads stdin cannot swallow the lines after it.
vm_script() {
  local encoded
  encoded="$(base64 | tr -d '\n')"
  vm_ssh "f=\$(mktemp) && echo '$encoded' | base64 -d > \"\$f\" && bash \"\$f\" < /dev/null; s=\$?; rm -f \"\$f\"; exit \$s" < /dev/null
}

# VMs of this job that a cancelled or crashed run left behind.
vm_list_ours() {
  tart list 2>/dev/null | awk -v prefix="$VM_PREFIX" '$1 == "local" && index($2, prefix) == 1 { print $2 }'
}

vm_remove() {
  local name="$1"
  tart stop "$name" > /dev/null 2>&1 || true
  tart delete "$name"
}
