# ADR: Supabase MCP writes need approval for DDL, and for DML unless the data is proven mock

- **Status**: Accepted on 2026-11-02 by the owner. Ships in the pull request that adds this record.
- **Date**: 2026-11-02
- **Author**: Platform engineering
- **Related**: [Schema rules](../../prisma/AGENTS.md), [Prisma and the live database](../prisma/README.md), [Support runbooks](../support/12-runbooks.md), [Verifying money changes](../../.claude/skills/finance/references/verification.md)

## Context

The previous rule banned all DDL and SQL writes through an MCP server. It followed an incident in which ad-hoc DDL through the Supabase MCP dropped the legacy support tables while production still read them, which broke the SLA sweep, the privacy export and the staff support metrics (#2271). The shared MCP entry was then pinned to `--read-only`.

The owner wants a rule that tracks risk instead of the tool: a schema change is a big change, while data changes on mock data are cheap to repeat. One Supabase project serves both development and production, so the environment cannot tell an agent which case it is in.

## Decision

1. **Reads need no approval.** `SELECT`, catalogs, logs and advisors are always allowed.
2. **DDL always needs the owner's explicit approval** of the exact statement, in the current conversation. Approval covers that statement only. An approved change is mirrored in `prisma/schema.prisma` or `prisma/sql/*.sql` in the same pull request, because a later `db push` would otherwise drop or revert it.
3. **DML needs no approval only when a `SELECT` run first proves every touched row is mock data**, meaning rows owned by the seed or QA accounts. Real or unproven rows, and statements that cannot be scoped to proven rows, need the owner's approval. Mock-ness is proven per statement, never assumed from the environment, because rows that look like QA data may be real.
4. **Enforcement is partial by design.** `.claude/settings.json` asks before `apply_migration`, `merge_branch` and `reset_branch`. `execute_sql` can run either kind of statement, so it cannot be gated by tool name, and the rule for it is prose.
5. **The shared `.mcp.json.example` entry stays `--read-only`.** Until the owner sets up a write-capable entry, the server rejects writes whatever this policy allows.

## Consequences

- An agent can repair or reseed mock data without waiting, and cannot change a schema or touch real rows unasked.
- The policy is only as strong as the agent's `SELECT` proof. The `--read-only` flag remains the one hard gate, and lifting it is the owner's decision.

## Deprecated & Superseded Approaches

- **Blanket ban on DDL and SQL writes through any MCP server.** Replaced by the approval rules above. The `--read-only` pin and the `db:push` preflight remain the default path for schema changes.
