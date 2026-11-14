#!/usr/bin/env bash
# The whole pre-push check for the current worktree, behind the heavy lock.
# Usage: scripts/dev/pre-push-checks.sh <log-dir>
# Each step logs to <log-dir>/<step>.log; <log-dir>/summary.txt gets one
# "name rc=N Ns" line per step, then DONE. Exits 1 if any step failed.
set -u

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <log-dir>" >&2
  exit 2
fi
LOG_ARG="$1"

ROOT="$(git rev-parse --show-toplevel)" || exit 2
mkdir -p "$LOG_ARG" || exit 2
LOG="$(cd "$LOG_ARG" && pwd)" || exit 2
cd "$ROOT" || exit 2

# The installed binaries only: npx could fetch and run a package on demand.
BIN=node_modules/.bin
for tool in prisma tsc eslint prettier tsx jest; do
  if [[ ! -x "$BIN/$tool" ]]; then
    echo "missing $BIN/$tool: install or link node_modules in $ROOT first" >&2
    exit 2
  fi
done

# The heavy lock, as model-orchestration.md section 6b defines it.
LOCK=/tmp/fw-heavy.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "waiting for $LOCK"
  until mkdir "$LOCK" 2>/dev/null; do sleep 15; done
fi
trap 'rmdir "$LOCK"' EXIT
trap 'exit 130' INT TERM HUP

SUMMARY="$LOG/summary.txt"
: >"$SUMMARY"
FAILED=0

note() {
  echo "$*" | tee -a "$SUMMARY"
}

T0=$SECONDS
begin() {
  T0=$SECONDS
}
record() { # record <name> <rc>, after a step that logged to <log-dir>/<name>.log
  local name="$1"
  local rc="$2"
  [[ "$rc" -eq 0 ]] || FAILED=1
  note "$name rc=$rc $((SECONDS - T0))s"
}

# xargs runs its command once even on empty input with GNU and never with BSD;
# an empty list is skipped here so neither lints the whole repository.
run_on_files() { # run_on_files <nul-separated list> <command...>
  local list="$1"
  shift
  if [[ ! -s "$list" ]]; then
    echo "no files to check"
    return 0
  fi
  xargs -0 "$@" <"$list"
}

no_session_links() {
  local hits
  hits="$(git log --format=%B origin/dev..HEAD | grep -cE 'Claude-Session|claude\.ai/')"
  echo "commit body lines with a session trailer or claude.ai link: $hits"
  git log --format='%h %s' origin/dev..HEAD
  [[ "$hits" -eq 0 ]]
}

note "worktree $ROOT"
note "head start $(git rev-parse --short HEAD)"
note "origin/dev $(git rev-parse --short origin/dev)"
git merge-base --is-ancestor origin/dev HEAD ||
  note "warning: origin/dev is not merged into HEAD"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] ||
  note "warning: uncommitted edits; the checks below include them"

git diff -z --name-only --diff-filter=ACMR origin/dev...HEAD >"$LOG/changed.z"
grep -zE '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$' "$LOG/changed.z" >"$LOG/changed-src.z" || true
note "changed files $(tr -cd '\0' <"$LOG/changed.z" | wc -c | tr -d ' '), source files $(tr -cd '\0' <"$LOG/changed-src.z" | wc -c | tr -d ' ')"

begin
"$BIN/prisma" generate >"$LOG/generate.log" 2>&1
record generate $?

begin
NODE_OPTIONS=--max-old-space-size=6144 "$BIN/tsc" --noEmit --incremental false >"$LOG/tsc.log" 2>&1
record tsc $?

begin
run_on_files "$LOG/changed-src.z" "$BIN/eslint" --max-warnings=0 --no-warn-ignored -- >"$LOG/eslint.log" 2>&1
record eslint $?

begin
run_on_files "$LOG/changed.z" "$BIN/prettier" --check --ignore-unknown -- >"$LOG/prettier.log" 2>&1
record prettier $?

begin
"$BIN/tsx" scripts/ci/check-comment-archaeology.ts origin/prod >"$LOG/archaeology.log" 2>&1
record archaeology $?

begin
no_session_links >"$LOG/session-links.log" 2>&1
record session-links $?

begin
"$BIN/jest" --coverage=false --maxWorkers=2 >"$LOG/jest.log" 2>&1
record jest $?
grep -E '^(Test Suites|Tests):' "$LOG/jest.log" | sed 's/^/  /' | tee -a "$SUMMARY"

note "head end $(git rev-parse --short HEAD)"
note "DONE"
echo
echo "summary: $SUMMARY"
cat "$SUMMARY"
exit "$FAILED"
