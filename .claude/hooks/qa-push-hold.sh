#!/usr/bin/env bash
# Claude Code PreToolUse hook for Bash: blocks a `git push` to a branch while a
# preview QA run holds it. A hold is $FW_QA_HOLD_DIR/<branch, "/" as "__">
# (default /tmp/fw-qa-hold) holding "<PR> <head> <UTC ISO time>"; a hold older
# than 3 hours is stale. Fails open: an error here allows the push.
set -u

HOLD_DIR="${FW_QA_HOLD_DIR:-/tmp/fw-qa-hold}"
STALE_SECONDS=10800

# Fast path for every Bash call: no hold anywhere means nothing to read.
[ -d "$HOLD_DIR" ] || exit 0
set -- "$HOLD_DIR"/*
[ -e "$1" ] || exit 0

allow() {
  echo "qa-push-hold: $1; allowing the command" >&2
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

# `git`, then only global options (with -C/-c taking a value), then `push`.
GIT_PUSH='(^|[^[:alnum:]_./-])git(([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)|([[:space:]]+-[^[:space:]]+))*[[:space:]]+push([[:space:]]|$)'
[[ "$CMD" =~ $GIT_PUSH ]] || exit 0

# Branches the push can reach: the branch checked out where it runs (the call's
# cwd, a `cd <dir>` or a `git -C <dir>`) and every word after `push`.
DIRS=()
[ -n "$CWD" ] && DIRS+=("$CWD")
WORDS=()
read -r -a WORDS <<<"$(printf '%s' "$CMD" | tr "\n;&|()\"'" '        ')"
BRANCHES=()
AFTER_PUSH=false
PREV=""
for w in "${WORDS[@]+"${WORDS[@]}"}"; do
  if [ "$PREV" = cd ] || [ "$PREV" = -C ]; then
    case "$w" in
      /*) DIRS+=("$w") ;;
      "~"*) DIRS+=("$HOME${w#"~"}") ;;
      *) DIRS+=("${CWD:-.}/$w") ;;
    esac
  fi
  if [ "$AFTER_PUSH" = true ]; then
    case "$w" in
      -*) ;;
      *)
        w="${w#+}"
        BRANCHES+=("${w%%:*}" "${w#*:}")
        ;;
    esac
  fi
  [ "$w" = push ] && AFTER_PUSH=true
  PREV="$w"
done
for d in "${DIRS[@]+"${DIRS[@]}"}"; do
  b="$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)" && BRANCHES+=("$b")
done

mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

NOW="$(date +%s)"
for b in "${BRANCHES[@]+"${BRANCHES[@]}"}"; do
  b="${b#refs/heads/}"
  case "$b" in '' | HEAD) continue ;; esac
  HOLD="$HOLD_DIR/${b//\//__}"
  [ -f "$HOLD" ] || continue
  SET_AT="$(mtime "$HOLD")" || allow "could not read the age of $HOLD"
  AGE=$((NOW - SET_AT))
  read -r PR HEAD_SHA AT _ <"$HOLD" || true
  if [ "$AGE" -ge "$STALE_SECONDS" ]; then
    echo "qa-push-hold: the hold on $b (PR ${PR:-?}, head ${HEAD_SHA:-?}) is $((AGE / 60)) min old, older than 3 hours, so it is stale; allowing the push" >&2
    continue
  fi
  echo "qa-push-hold: push blocked. A preview QA run holds branch $b: PR ${PR:-?} at head ${HEAD_SHA:-?}, hold set ${AT:-?}, $((AGE / 60)) min ago. Pushing now would make the run describe two builds; wait for the QA run to end, or for the orchestrator to remove the hold file $HOLD." >&2
  exit 2
done
exit 0
