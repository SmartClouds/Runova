#!/usr/bin/env bash
# Removes the job's container (start.sh), and with it every process the steps left running: Xvfb,
# a test server's SSH session, a stuck test. Runs even when the job failed or was cancelled.
# Containers the tests started on the host's Docker are the Runner cleanup step's to remove.
set -uo pipefail

if [ -n "${CI_CONTAINER:-}" ]; then
  docker rm --force "$CI_CONTAINER" > /dev/null && echo "Removed $CI_CONTAINER."
fi
