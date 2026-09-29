#!/usr/bin/env bash
# Run jest from inside the auth-prod agent worktree.
#
# The repo's jest.config ignores /.claude/worktrees/ so that stale agent
# checkouts are not crawled — which also ignores the worktree doing the
# testing. This re-includes it without editing the shared config.
cd /home/kaustav/Desktop/familiarise_web/.claude/worktrees/auth-prod || exit 1
exec npx jest --coverage=false \
  --modulePathIgnorePatterns="/node_modules/" \
  --testPathIgnorePatterns="/node_modules/" "/__mocks__/" "/setup\.ts$" "/__tests__/fixtures/" \
  --silent \
  "$@"
