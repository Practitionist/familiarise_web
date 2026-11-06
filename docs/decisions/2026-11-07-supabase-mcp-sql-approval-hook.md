# ADR: Supabase MCP reads run freely; every write waits for the owner, enforced by a hook

- **Status**: Accepted on 2026-11-07 by the owner. Ships in the pull request that adds this record.
- **Date**: 2026-11-07
- **Author**: Platform engineering
- **Related**: [Schema rules](../../prisma/AGENTS.md), [Prisma and the live database](../prisma/README.md), [Support runbooks](../support/12-runbooks.md), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Permission modes](https://code.claude.com/docs/en/permission-modes)

## Context

One Supabase project serves development and production, so there is no dev database today: every query an agent runs through the Supabase MCP is a production query. Agents need that MCP to read money truth, catalogs and logs many times a session, and the owner wants them to batch those reads. Writes are different. Ad-hoc DDL through the MCP once dropped the legacy support tables while production still read them, which broke the SLA sweep, the privacy export and the staff support metrics (#2271).

The owner keeps a write-capable MCP entry locally and runs Claude Code in bypass-permissions mode, so the gate has to work with writes possible and with most prompts switched off.

## Decision

1. **Reads run without a prompt.** A `.claude/settings.json` `PreToolUse` hook, `.claude/hooks/supabase-sql-gate.ts`, reads each `execute_sql` call. It tokenises the batch the way PostgreSQL's lexer does (identifiers, `E''`/`U&''` strings, quoted identifiers, dollar quotes with non-ASCII tags, `--` comments ending at either line break), drops comments and literals, splits the batch into statements, and returns `allow` only when every statement starts with `SELECT`, `WITH` or `SHOW` (or is an `EXPLAIN` of one), with no data-modifying CTE, no `SELECT … INTO`, no `FOR UPDATE`/`FOR SHARE`, no known mutating built-in, quoted or not (`setval`, `nextval`, `set_config`, backend signalling, WAL, replication-slot and origin functions, statistics resets, BRIN/GIN maintenance, `lo_*`, `dblink*`, advisory locks, `http*`) and no schema-qualified call outside `pg_catalog`. A `U&"…"` identifier asks, because its escapes can spell any name. Several reads in one call are encouraged.
2. **Everything else asks.** DML, DDL, `SET`, `DO`, `COPY`, `CALL`, transaction control, and any query the hook cannot parse get `ask`, with a reason naming the statement type and saying it runs against the shared dev+prod database. The hook fails closed: an unparseable query asks, a hook crash exits 2, and `"onFailure": "block"` blocks the call if the hook times out or cannot start (a timed-out hook otherwise lets the call through).
3. **Under bypass permissions the hook denies instead of asking.** The hooks reference defines `"ask"` as "prompts the user to confirm" but does not say a hook's `ask` survives `bypassPermissions`, while `deny` "prevents the tool call" in every mode. So when `permission_mode` is `bypassPermissions`, a non-read gets `deny` with a reason telling the agent to show the owner the statement and wait; the owner approves by pressing Shift+Tab to leave bypass mode, and the re-run then gets the `ask` prompt.
4. **The other write tools always ask.** `apply_migration`, `create_branch`, `create_project`, `delete_branch`, `deploy_edge_function`, `merge_branch`, `pause_project`, `rebase_branch`, `reset_branch` and `restore_project` are `permissions.ask` rules, written as `mcp__*supabase*__<tool>` so a differently named Supabase entry is covered. The permission-modes page lists explicit ask rules among the actions no mode auto-approves, including `bypassPermissions`.
5. **Schema changes keep their path.** They go through `prisma/schema.prisma`, the sidecars and the human-run `db:push`. MCP DDL is for an owner-approved emergency only, and is mirrored in the schema or a sidecar in the same pull request.
6. **Room for a split, not built.** When a separate dev Supabase project exists, the hook can allow writes on that project ref without a prompt. There is no project-ref configuration until then.

## Alternatives considered

- **A blind read-only MCP entry** (`--read-only`). Safe, but it blocks the owner-approved emergency write and every mock-data repair, and the owner declined to make the local entry read-only. The shared `.mcp.json.example` entry stays `--read-only` as the default for new machines.
- **A blanket ban on MCP writes, in prose.** The previous rule. Prose binds nothing, and it had to be broken whenever the owner wanted a write.
- **Prose-only approval** (the first version of this PR: DDL with approval, DML free when a `SELECT` proves the rows are mock). The proof is not bound to the write, `SELECT` itself can write, and nothing enforced it.
- **An ask rule on every `execute_sql` call.** Enforced in every mode, but it prompts on every read, which defeats batching and trains the owner to approve without reading.
- **The classifier hook (chosen).** Reads stay free, every write shows the owner what it is before it runs, and it works with a write-capable entry and in bypass mode.

## Consequences

- An agent can read freely and batch its reads; it cannot write to the shared database without the owner seeing the statement type first.
- The classifier is a lexer, not a Postgres parser. A user-defined function that writes would pass as a read; the repository defines none that are callable (its `prisma/sql` functions are trigger functions). Extend `MUTATING_FUNCTIONS` when one appears.
- The hook binds Claude Code only. Other agents follow the prose in `prisma/AGENTS.md`.

## Deprecated & Superseded Approaches

- **Blanket ban on DDL and SQL writes through any MCP server**, then **DDL with approval and DML free on proven mock rows**. Both were prose rules with no enforcement on `execute_sql`; replaced by the hook above.
