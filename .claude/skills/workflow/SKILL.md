---
name: workflow
description: How engineering work gets planned and reviewed in this repo, independent of the code domain — triaging every review comment on a pull request into legit/BS/already-fixed/partly-fixed/incorrectly-fixed by checking each claim against current code, and choosing which Claude tier (advisor/teacher/student, with per-role effort levels) runs which part of a large multi-agent effort. Use when the user says "triage the PR comments", "are these review comments legit", "go through the PR feedback", or when planning a fleet of subagents, deciding between Fable/Opus/Sonnet/Haiku for a task, or a session keeps hitting usage limits.
---

# Workflow

This is the index for cross-cutting process — how a PR gets reviewed and how a multi-agent effort gets staffed — as opposed to the domain skills, which are about what to build.

| Reference                           | Purpose                                                                                                                                                                                  | Read it when                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `references/pr-comment-triage.md`   | Running the CodeRabbit CLI locally before merge (chunked by directory, delta rounds by commit), reading the Sonar gate through the sonarqube MCP, triaging every review comment — including CodeRabbit's outside-diff and nitpick comments in review bodies — against current code, fixing the legit-pending ones, validating against a dev server with mock data, resolving bot threads without replying, and recording each round's findings in the PR body's "Review rounds" section (or a linked PR comment past GitHub's 65,536-character body limit). | Asked to triage PR comments, address bot/reviewer feedback, or run a review round before merging a PR. |
| `references/model-orchestration.md` | The advisor (Fable) / teacher (Opus) / student (Sonnet, Haiku) split, per-role effort levels, session-budget economics, and the resume-from-worktree pattern for surviving usage limits. | Planning a fleet of subagents, choosing a model tier, or a session keeps hitting usage walls. |

## Non-negotiables

Every reviewer claim gets checked against the code as it stands today, not accepted or dismissed on the strength of the comment alone. Money-semantics threads on a non-money PR are reported as needs-decision and never changed unilaterally. A subagent fleet always runs its executors on a cheaper tier than the orchestrator that dispatches them, and every long-running agent prompt carries a limit clause so a dying agent leaves a resumable worktree rather than stranded work. Full detail and sources live in the two references above.
