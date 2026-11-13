#!/usr/bin/env bash
# The two halves of a website API test suite for CircleCI Smarter Testing (test-suites.yml). Both
# run from apps/website/api, on a solution that is already built in Release.
#
#   dotnet-suite.sh discover <test project>
#   dotnet-suite.sh run <test project> <junit file>      (test classes on stdin, one per line)
#
# A test atom is a test class. xunit v3 filters by class, and a class's tests share its fixture, so
# splitting a class between two jobs would only start the fixture twice.
set -euo pipefail

mode=${1:?discover or run}
project=${2:?test project folder}

case "$mode" in
  discover)
    # --list-tests prints a banner and then one indented display name per test, as
    # Namespace.Class.Method or Namespace.Class.Method(argument: value) for a theory row. Dropping
    # the arguments and then the method leaves the class. Nothing is run and no container starts.
    dotnet test --project "$project" --no-build --configuration Release --list-tests \
      | tr -d '\r' \
      | sed -n 's/^  //p' \
      | sed -e 's/(.*$//' -e 's/\.[^.]*$//' \
      | sort -u
    ;;
  run)
    # Windows passes the report path with backslashes, which dirname would not split.
    junit=${3:?junit file}
    junit=${junit//\\//}
    filters=()
    # The last atom comes without a newline, so read fails on it but has still filled atom.
    while IFS= read -r atom || [ -n "$atom" ]; do
      atom=${atom%$'\r'}
      if [ -n "$atom" ]; then filters+=(--filter-class "$atom"); fi
    done
    if [ ${#filters[@]} -eq 0 ]; then
      echo "No test classes were passed on stdin." >&2
      exit 1
    fi
    # Repeated --filter-class options are an OR. xunit writes the report to
    # <results directory>/<file name>, which is where Smarter Testing looks for it.
    dotnet test --project "$project" --no-build --configuration Release --output Detailed \
      --results-directory "$(dirname "$junit")" \
      --report-xunit-junit --report-xunit-junit-filename "$(basename "$junit")" \
      "${filters[@]}"
    ;;
  *)
    echo "Unknown mode: $mode" >&2
    exit 2
    ;;
esac
