---
name: merge-protocol
description: The merge rules for parallel agent trains — when a safety pull request may merge, who verifies and squash-merges, when an issue may be closed by hand, and how pull requests are bucketed by theme. Use when landing pull requests built by another agent, closing issues after a train, or planning how many pull requests a sweep should produce.
---

# Merge protocol for parallel agent trains

Owner decision of 2026-10-26, recorded in `docs/decisions/2026-10-26-launch-sweep-observability-and-money-holds.md` (ADR-12). These rules are procedure for agents, so they live here and not in an ADR.

## Landing a safety pull request

- A safety pull request built by Codex merges only after a comment that starts with `READY TO LAND` and names a head commit. Compare it with the live head before anything else: `gh pr view <n> --json headRefOid`. A different SHA voids the comment, and the pull request waits for a fresh one.
- Merge in the order the train's umbrella issue lists. Never merge a later pull request first, even if it is green.
- The reviewing agent (Claude) does three things before merging: verifies the pull request's claims against the diff and current code, runs a medium-depth review (`pr-comment-triage.md`), and squash-merges. Do not merge your own pull request on your own `READY TO LAND`.
- A money pull request keeps its extra rule from the finance and booking skills: money semantics are never changed during triage.

## Closing issues

- Close an issue by hand only when it is a duplicate, superseded, not an issue, or a verify-and-close item whose fix already shipped.
- Every manual close carries a comment with the evidence: the duplicate's number, the superseding pull request, the code reference that shows there is no bug, or the SHA and command that prove the fix.
- Otherwise leave the issue to the merged pull request's `Fixes #<n>` and do not close it early.

## Bucketing

- Group findings into one pull request per theme (for example "ticker and Sentry signals", "money holds", "auth abuse controls"). Do not open one pull request per finding.
- Name the issues a bucket covers in its body as `Part of #<n>`, so the umbrella issue stays the index.

## Verify

```bash
gh pr view <n> --json headRefOid,isDraft,state
gh pr view <n> --comments | rg "READY TO LAND"
```
