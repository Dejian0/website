#!/usr/bin/env bash
# Pre-commit privacy guard. Never prints matched patterns, only file names.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
denylist="${PRIVACY_DENYLIST:-$(git rev-parse --git-path info/private-denylist)}"
fail=0

while IFS= read -r -d '' f; do
  if [[ "$f" =~ \.[pP][dD][fF]$ ]]; then # any case (bash 3.2 has no ${f,,})
    echo "privacy-check: PDF files may not be committed: $f" >&2
    fail=1
  fi
  if [[ -f "$root/$f" ]]; then
    size=$(wc -c < "$root/$f")
    if (( size > 2097152 )); then
      echo "privacy-check: file larger than 2 MB: $f" >&2
      fail=1
    fi
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

if [[ -f "$denylist" ]]; then
  patterns="$(mktemp)"
  trap 'rm -f "$patterns"' EXIT
  grep -Ev '^[[:space:]]*(#|$)' "$denylist" > "$patterns" || true
  if [[ -s "$patterns" ]]; then
    rc=0
    grep -Eqif "$patterns" /dev/null 2>/dev/null || rc=$?
    if (( rc == 2 )); then
      echo "privacy-check: denylist is invalid (fix it); commit rejected." >&2
      exit 1
    fi
    current=""
    while IFS= read -r line; do
      if [[ "$line" == "+++ "* ]]; then
        current="${line#+++ }"; current="${current#b/}"
      elif [[ "$line" == "+"* ]]; then
        rc=0
        printf '%s\n' "${line:1}" | grep -Eqif "$patterns" 2>/dev/null || rc=$?
        if (( rc == 0 )); then
          echo "privacy-check: blocked content in added lines of: $current" >&2
          fail=1
        elif (( rc != 1 )); then
          echo "privacy-check: denylist check failed on: $current" >&2
          fail=1
        fi
      fi
    done < <(git diff --cached -U0 --no-color)
  fi
fi

if (( fail )); then
  echo "privacy-check: commit rejected." >&2
  exit 1
fi
