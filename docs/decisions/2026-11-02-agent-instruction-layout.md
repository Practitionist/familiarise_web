# ADR: Agent instructions are one shared root file plus nested per-directory files

- **Status**: Accepted on 2026-11-02 by the owner. Ships in the pull request that adds this record.
- **Date**: 2026-11-02
- **Author**: Platform engineering
- **Related**: [Claude Code memory documentation](https://code.claude.com/docs/en/memory), [agents.md](https://agents.md), [Documentation skill](../../.claude/skills/documentation/SKILL.md)

## Context

The repository had one 11 KB `AGENTS.md` that mixed universal bans, money and database invariants, worktree hygiene and documentation practice, and a `CLAUDE.md` symlink to it. Claude Code reads the symlinked content once (it skips an `AGENTS.md` it has already loaded), so nothing was double-loaded. The cost was elsewhere:

- Every session carried every domain's rules, whether or not the work touched that domain. Anthropic's guidance is under 200 lines per file, and says longer files reduce adherence.
- The Edit and Write tools refuse to write through a symlink, and a Windows clone checks a committed symlink out as a one-line text file.
- Advisory prose was doing the work of deterministic checks.

## Decision

1. **`AGENTS.md` is the single source of truth for every agent** (Claude Code, Codex and others). Each `CLAUDE.md` is a real file containing only `@AGENTS.md`. Nothing is Claude-only: other agents also use the `.claude/` skills and subagents.
2. **The root file holds only rules that apply everywhere**, as one-line bans with a pointer. Section numbers are stable, so existing citations such as `AGENTS.md §1.3` keep resolving.
3. **Directory rules live in nested `AGENTS.md` files** (`lib/cron/`, `lib/payments/`, `lib/booking/`, `prisma/`, `docs/`), each paired with a one-line `CLAUDE.md` import. Claude Code's default mode ignores a nested `AGENTS.md` once any `CLAUDE.md` sits above it, and a project cannot change that mode, so the paired import is what makes the nested file load. Claude Code loads a nested `CLAUDE.md` when it first reads a file in that directory; other agents use the nearest `AGENTS.md`.
4. **Rules that can be checked deterministically are checked, and the prose shrinks to a pointer**:
   - `.claude/settings.json` denies `prisma db push`, the database-writing `npm run db:*` scripts, `next dev` and `next build` to Claude Code in every permission mode. The owner runs them. Supabase MCP writes are gated separately ([Supabase MCP SQL approval hook](./2026-11-07-supabase-mcp-sql-approval-hook.md)).
   - `eslint.config.mjs` already rejects `eslint-disable*` and `@ts-*` comments (`noInlineConfig`, `ban-ts-comment`).
   - `scripts/ci/check-comment-archaeology.ts` runs in `Release checks` on release pull requests into `prod` (full CI is disabled before launch) and fails when comment lines added since `prod` cite ticket numbers or planning ids.

## Consequences

- The root file drops from about 11 KB to about 8 KB. The rest loads only when work touches that directory.
- A nested file loads only after the agent reads a file in its directory, so a brand-new file in an unread directory does not trigger it. That is why each root ban keeps a one-line statement and a pointer instead of being removed.
- The `permissions.deny` rules bind Claude Code only. Other agents rely on the prose rules and CI.
- CodeRabbit auto-discovers only the root `AGENTS.md`, so domain risks for reviews stay in `.coderabbit.yaml` path instructions.

## Deprecated & Superseded Approaches

- **`CLAUDE.md` as a symlink to `AGENTS.md`.** Replaced by a one-line `@AGENTS.md` import: it works on Windows, and Claude's edit tools can write to it.
- **One flat root file for every domain.** Replaced by the root plus nested files above. Delete any new rule that restates a nested file's content in the root.
