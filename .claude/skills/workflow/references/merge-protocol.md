---
name: merge-protocol
description: The merge rules for parallel agent trains — when a safety pull request may merge, who verifies and squash-merges, when an issue may be closed by hand, and how pull requests are bucketed by theme. Use when landing pull requests built by another agent, closing issues after a train, or planning how many pull requests a sweep should produce.
---

# Merge protocol for parallel agent trains

Owner decision of 2026-10-26, recorded in `docs/decisions/2026-10-26-launch-sweep-observability-and-money-holds.md` (ADR-12). These rules are procedure for agents, so they live here and not in an ADR.

## Landing a safety pull request

- A safety pull request built by Codex merges only after a comment whose body begins with `READY TO LAND` and names a head commit. Accept it only from the account that built the pull request or from the owner; ignore quoted text and unrelated mentions of the phrase. Compare the named SHA with the live head before anything else: `gh pr view <n> --json headRefOid`. A different SHA voids the comment, and the pull request waits for a fresh one.
- Merge in the order the train's umbrella issue lists. Never merge a later pull request first, even if it is green.
- The reviewing agent (Claude) does three things before merging: verifies the pull request's claims against the diff and current code, runs a medium-depth review (`pr-comment-triage.md`), and squash-merges. Do not merge your own pull request on your own `READY TO LAND`.
- A money pull request keeps its extra rule from the finance and booking skills: money semantics are never changed during triage.

## Release gate for a pull request into `prod`

- The release gate is `scripts/ci/check-db-schema-required.ts --live`. It diffs the live database against `prisma/schema.prisma` and fails when the schema declares a table, column, enum type or enum value the database lacks. It is read-only, and it ignores sidecar objects and objects only the database has.
- The release cutter runs it locally before opening the `prod` pull request: `npx --no-install tsx scripts/ci/check-db-schema-required.ts --live` (needs `DIRECT_URL` and `DATABASE_URL`; it never writes; `--no-install` fails rather than downloading `tsx` when dependencies are missing). Paste its full output into the pull request body. A pass prints `check-db-schema-required: ok`.
- The organisation is on GitHub Free, which has no branch protection on private repositories, so nothing can make this a required check. Once Actions runs, the **Release schema gate** job (`release-schema-gate` in `.github/workflows/db-live-drift.yml`) is the record on every pull request into `prod` opened from a branch of this repository. A fork's pull request gets no run, because the job needs the database secrets, so the cutter's pasted output is its only record.
- On failure, stop and read why it failed. When it lists objects the live database lacks, the human runs the push preflight (`npm run db:preflight`) and then the push (`npm run db:push`). Never an agent (`AGENTS.md` section 2.3). When it could not compare (a missing URL, a failed `prisma migrate diff` or a failed catalog read), it proves nothing about the schema: fix that cause instead. Re-run the gate, paste the new output, then merge.

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
gh pr view <n> --json headRefOid,author,comments \
  --jq '.headRefOid as $h | .author.login as $pr | .comments[] | select(.body | startswith("READY TO LAND")) | {commentAuthor: .author.login, prAuthor: $pr, createdAt: .createdAt, matchesHead: ([.body | scan("`([0-9a-f]{40})`") | .[0]] | first == $h)}'
```

This listing only narrows the candidates; it is not the merge gate. `matchesHead` compares the first full 40-character SHA written in backticks with the live head, so a SHA inside quoted or unrelated text does not count. Accept a comment only when `matchesHead` is true, the comment is newer than the head commit, and `commentAuthor` is `prAuthor` or the repository owner's account. Report which of the two it was. A comment from any other account does not count, even when it carries the right SHA.
