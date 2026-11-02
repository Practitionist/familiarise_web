# Schema & SQL Sidecars

Applies to `prisma/schema.prisma` and `prisma/sql/*.sql`. The root `AGENTS.md` still applies.

1. **Check Postgres before writing a reconciler**: read `prisma/sql/{check-constraints,ledger-triggers,payment-legs-triggers}.sql`. If a `CHECK` constraint, the `EXCLUDE USING gist` index (`occurrence_no_confirmed_overlap`), or a `CONSTRAINT TRIGGER` (`ledger_txn_balanced`, `payment_legs_sum_to_amount`, `ledger_*_immutable`) already prevents an invalid state at `COMMIT`, **do not** write application-level sweeps to re-verify it. Only reconcile across external vendor boundaries (Razorpay, Stream, Resend, Supabase Storage).
2. **One database serves dev and prod across worktrees.** Never run `prisma db push` or `npm run db:*` autonomously (`.claude/settings.json` denies them to Claude Code); the human runs the `db:push` preflight. Run `npx prisma generate` after editing `prisma/schema.prisma`.
3. **Check live-DB drift read-only** with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`. A plain `db push` would drop the `prisma/sql` sidecar uniques.
4. **New `CHECK` constraints, partial unique indexes and triggers belong in `prisma/sql/*.sql`.** A trigger that rebuilds a summary or aggregate must be `FOR EACH STATEMENT` with transition tables, or a dirty-mark plus a sweep. Guard and constraint triggers stay `FOR EACH ROW`.
5. **No DDL or SQL writes through an MCP server.** The reviewed Supabase MCP entry is read-only and project-scoped; schema changes go through `prisma/schema.prisma`, the human-run `db:push` preflight, and `prisma/sql/*.sql` sidecars.
6. **Playbook**: `.claude/skills/schema/SKILL.md`.
