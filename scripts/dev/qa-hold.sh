#!/usr/bin/env bash
# The QA push hold that .claude/hooks/qa-push-hold.sh enforces.
# Usage: scripts/dev/qa-hold.sh take <branch> <PR> <head>
#        scripts/dev/qa-hold.sh release <branch> "<line take printed>"
# take writes $FW_QA_HOLD_DIR/<key> (default /tmp/fw-qa-hold; key = branch with
# "%" as "%25" and "/" as "%2F") without overwriting, prints the line it wrote,
# and refuses (exit 1) while another run's hold is under 3 hours old.
# release removes the file only if it still holds that exact line.
set -u

HOLD_DIR="${FW_QA_HOLD_DIR:-/tmp/fw-qa-hold}"

usage() {
  echo "usage: $0 take <branch> <PR> <head> | release <branch> <line>" >&2
  exit 2
}

hold_file() { # hold_file <branch>
  local branch="$1"
  local pct="%"
  local key="${branch//"$pct"/%25}"
  key="${key//\//%2F}"
  printf '%s/%s' "$HOLD_DIR" "$key"
}

take() { # take <branch> <PR> <head>
  local branch="$1"
  local pr="$2"
  local head_sha="$3"
  local file line tmp fresh
  file="$(hold_file "$branch")"
  line="$pr $head_sha $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$HOLD_DIR" || exit 1
  if (set -o noclobber && printf '%s\n' "$line" >"$file") 2>/dev/null; then
    printf '%s\n' "$line"
    return 0
  fi
  # A failed age check must not read as stale and overwrite another run's hold.
  fresh="$(find "$file" -mmin -180)" || exit 1
  if [[ -n "$fresh" ]]; then
    echo "refused: a fresh hold already exists for $branch ($(cat "$file")); another QA run is on it" >&2
    exit 1
  fi
  tmp="$file.$$"
  printf '%s\n' "$line" >"$tmp" && mv -f "$tmp" "$file" || exit 1
  echo "replaced a stale hold for $branch" >&2
  printf '%s\n' "$line"
}

release() { # release <branch> <line>
  local branch="$1"
  local line="$2"
  local file
  file="$(hold_file "$branch")"
  if [[ ! -f "$file" ]]; then
    echo "no hold for $branch"
    return 0
  fi
  if [[ "$(cat "$file")" != "$line" ]]; then
    echo "not removed: the hold for $branch is another run's ($(cat "$file"))" >&2
    exit 1
  fi
  rm -f "$file"
  echo "released the hold for $branch"
}

case "${1:-}" in
  take)
    [[ "$#" -eq 4 ]] || usage
    take "$2" "$3" "$4"
    ;;
  release)
    [[ "$#" -eq 3 ]] || usage
    release "$2" "$3"
    ;;
  *) usage ;;
esac
