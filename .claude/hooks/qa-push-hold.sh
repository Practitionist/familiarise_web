#!/usr/bin/env bash
# Claude Code PreToolUse hook for Bash: blocks a `git push` while a preview QA
# run holds a branch it could touch. A hold is $FW_QA_HOLD_DIR/<key> (default
# /tmp/fw-qa-hold), key = the branch with "%" as "%25" and "/" as "%2F", holding
# "<PR> <head> <UTC ISO time>"; scripts/dev/qa-hold.sh writes and removes it.
# A hold older than 3 hours is stale. Fails open: an error here allows the push.
# The rule is deliberately conservative: a false block is cheap, a missed one is
# not. Candidates are the branch checked out in every directory involved (cwd,
# each absolute `cd`/`-C` dir) plus every plain word after any `push`; --all,
# --mirror, --branches, --repo, a `*` refspec, a bare `:` or any relative
# `cd`/`-C` dir block on any fresh hold.
# A guard, not a boundary. Known limits: remote.*.push and push.default config,
# git aliases, shell functions and variables that hide the word push; a quoted
# string that merely contains 'git push' is blocked, harmlessly.
set -u

HOLD_DIR="${FW_QA_HOLD_DIR:-/tmp/fw-qa-hold}"
STALE_SECONDS=10800

# Fast path for every Bash call: no hold anywhere means nothing to read.
[[ -d "$HOLD_DIR" ]] || exit 0
set -- "$HOLD_DIR"/*
[[ -e "$1" ]] || exit 0

allow() {
  local reason="$1"
  echo "qa-push-hold: $reason; allowing the command" >&2
  exit 0
}

INPUT="$(cat)" || allow "could not read the hook input"
case "$INPUT" in
  *push*) ;;
  *) exit 0 ;;
esac

if command -v jq >/dev/null 2>&1; then
  CMD="$(printf '%s' "$INPUT" | jq -er '.tool_input.command | strings' 2>/dev/null)" ||
    allow "could not parse the hook input"
  CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty | strings' 2>/dev/null)" ||
    allow "could not parse the hook input"
else
  PARSED="$(printf '%s' "$INPUT" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = JSON.parse(s);
      const cmd = j && j.tool_input && j.tool_input.command;
      if (typeof cmd !== "string") process.exit(1);
      const cwd = typeof j.cwd === "string" ? j.cwd : "";
      process.stdout.write(cwd.replace(/\n/g, " ") + "\n" + cmd);
    });
  ' 2>/dev/null)" || allow "could not parse the hook input"
  CWD="${PARSED%%$'\n'*}"
  CMD="${PARSED#*$'\n'}"
fi

SQ="'"
# `git`, then only global options (-C/-c take a value, maybe quoted), then `push`.
GIT_PUSH="(^|[^[:alnum:]_./-])git(([[:space:]]+-[Cc][[:space:]]+(\"[^\"]*\"|${SQ}[^${SQ}]*${SQ}|[^[:space:]]+))|([[:space:]]+-[^[:space:]]+))*[[:space:]]+push([[:space:]]|\$)"
[[ "$CMD" =~ $GIT_PUSH ]] || exit 0

DIRS=()
ANY_HOLD=false
# A relative `cd`/`-C` depends on every earlier one, so it checks every hold.
add_dir() { # add_dir <dir as written>
  local dir="$1"
  case "$dir" in
    /*) DIRS+=("$dir") ;;
    "~"*) DIRS+=("$HOME${dir#"~"}") ;;
    *) ANY_HOLD=true ;;
  esac
}
[[ -n "$CWD" ]] && DIRS+=("$CWD")
QUOTED_DIR="(^|[^[:alnum:]_-])(cd|-C)[[:space:]]+(\"([^\"]*)\"|${SQ}([^${SQ}]*)${SQ})"
REST="$CMD"
while [[ "$REST" =~ $QUOTED_DIR ]]; do
  add_dir "${BASH_REMATCH[4]}${BASH_REMATCH[5]}"
  REST="${REST#*"${BASH_REMATCH[0]}"}"
done

# Words, with every command separator as its own ";" word and quotes dropped.
FLAT="${CMD//$'\n'/ ; }"
FLAT="${FLAT//[;&|()]/ ; }"
FLAT="${FLAT//[\"${SQ}]/ }"
WORDS=()
read -r -a WORDS <<<"$FLAT"

CANDIDATES=()
AFTER_PUSH=false
PREV=""
for w in "${WORDS[@]+"${WORDS[@]}"}"; do
  if [[ "$w" == ";" ]]; then
    AFTER_PUSH=false
  elif [[ "$PREV" == "cd" || "$PREV" == "-C" ]]; then
    add_dir "$w"
  elif [[ "$AFTER_PUSH" == "true" ]]; then
    case "$w" in
      --all | --mirror | --branches | --repo | --repo=* | :) ANY_HOLD=true ;;
      -*) ;;
      *"*"*) ANY_HOLD=true ;;
      *)
        w="${w#+}"
        CANDIDATES+=("${w%%:*}" "${w#*:}")
        ;;
    esac
  elif [[ "$w" == "push" ]]; then
    AFTER_PUSH=true
  fi
  PREV="$w"
done

for d in "${DIRS[@]+"${DIRS[@]}"}"; do
  b="$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)" && CANDIDATES+=("$b")
done

mtime() {
  local file="$1"
  stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null
}

NOW="$(date +%s)"
check_hold() { # check_hold <hold file> <branch or description>; exits 2 on a fresh hold
  local hold="$1"
  local what="$2"
  local set_at age pr head_sha at rest
  [[ -f "$hold" ]] || return 0
  set_at="$(mtime "$hold")" || allow "could not read the age of $hold"
  age=$((NOW - set_at))
  read -r pr head_sha at rest <"$hold" || true
  if [[ "$age" -ge "$STALE_SECONDS" ]]; then
    echo "qa-push-hold: the hold on $what (PR ${pr:-?}, head ${head_sha:-?}) is $((age / 60)) min old, older than 3 hours, so it is stale; allowing the push" >&2
    return 0
  fi
  echo "qa-push-hold: push blocked. A preview QA run holds $what: PR ${pr:-?} at head ${head_sha:-?}, hold set ${at:-?}, $((age / 60)) min ago. Pushing now would make the run describe two builds; wait for the QA run to end, or for the orchestrator to remove the hold file $hold. If this push does not touch that branch, run it from another worktree, or ask the orchestrator." >&2
  exit 2
}

if [[ "$ANY_HOLD" == "true" ]]; then
  for hold in "$HOLD_DIR"/*; do
    check_hold "$hold" "a branch this push can reach (hold ${hold##*/})"
  done
fi

PCT="%"
for b in "${CANDIDATES[@]+"${CANDIDATES[@]}"}"; do
  b="${b#refs/heads/}"
  case "$b" in
    '' | HEAD) continue ;;
    *) ;;
  esac
  key="${b//"$PCT"/%25}"
  key="${key//\//%2F}"
  check_hold "$HOLD_DIR/$key" "branch $b"
done
exit 0
