#!/usr/bin/env bash
# The shell of the run steps in the Linux CI jobs (defaults.run.shell). GitHub writes each step's
# script to a file and calls this with its path. In the job's container (start.sh) it runs there,
# with the step's environment and working folder. Without one (a GitHub-hosted run, the Mac, or a
# step before the container started) it runs here, as `shell: bash` does by default.
script="$1"

if [ -z "${CI_CONTAINER:-}" ]; then
  exec bash -e "$script"
fi

# Every variable of the step, by name: `docker exec -e NAME` takes the value from this process,
# so values with spaces or newlines arrive whole. A few describe this shell, not the step.
env_args=()
while IFS= read -r var; do
  case "$var" in
    HOSTNAME | PWD | OLDPWD | SHLVL | _) ;;
    *[!A-Za-z0-9_]*) ;; # exported bash functions (BASH_FUNC_name%%)
    *) env_args+=(--env "$var") ;;
  esac
done < <(compgen -e)

exec docker exec "${env_args[@]}" --workdir "$PWD" "$CI_CONTAINER" bash -e "$script"
