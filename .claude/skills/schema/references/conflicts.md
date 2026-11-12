# Migration conflicts between branches

Versioned migrations are an ordered list, and two pull requests that each add a
migration can both be correct alone and wrong together. This reference gives the
rules that keep the list linear when several branches and worktrees work at once;
`multi-session-workflow.md` shows each failure as the CI check prints it.

## Rules

1. **Never run `migrate dev` against a shared database.** It diffs, can reset on
   drift, and writes to whatever database it is pointed at. Every worktree here
   shares one database and one `.env`, so a `migrate dev` from any worktree
   would act on the database production reads. Generate migrations against a
   local scratch container instead, either with
   `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`
   against a local shadow container, or with `prisma migrate dev --create-only`
   run with `DIRECT_URL` pointing at a local container.
2. **One migration per pull request.** Its folder timestamp must be later than
   the newest migration on the base branch before the pull request merges.
3. **If another pull request merges first, rebase, regenerate and rename.**
   Rebase onto the base, regenerate your unapplied migration against the new
   history, and `git mv` its folder to a later timestamp. Never edit a migration
   that has been applied anywhere: Prisma records its checksum, and an edited
   one is reported as modified after being applied
   ([migration histories](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/migration-histories),
   [schema changes in production](https://www.prisma.io/docs/guides/v7/database/schema-changes)).
4. **Add a CI linear-history check** that fails a pull request when any of these
   is false:
   - every new migration directory sorts after the newest directory on the base
     branch;
   - no existing migration file was changed;
   - `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code`
     exits 0, meaning the migrations produce exactly the schema file. The command
     exits 2 when the diff is non-empty
     ([CLI reference](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference)).
     Because it reads a migrations directory, it needs a shadow database: set
     `shadowDatabaseUrl` in `prisma.config.ts` to a scratch database in CI
     ([shadow database](https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/shadow-database)).

   `scripts/ci/check-migrations.ts` is that check. It filters only the drops of the
   `NULLS NOT DISTINCT` uniques the schema cannot declare, and it also requires every
   file to be wrapped in `BEGIN; … COMMIT;`. Prisma itself does not notice an edited
   applied migration: `migrate status` stayed `up to date` in the rehearsal.

## Resolving a conflict

- Resolve the `prisma/schema.prisma` merge conflict first, by hand, as a normal
  text merge.
- Then regenerate your migration from the resolved schema. Never hand-merge two
  `migration.sql` files: the SQL of each was computed against a different
  starting schema, so a textual merge can pass review and still not produce the
  schema file.
- Run `npx prisma generate` from the main checkout, not a worktree, because the
  worktrees share one `node_modules` (root `AGENTS.md` section 3).

## Worked example

Priya's branch adds `20261110090000_add_plan_sort_order` and Hannah's branch
adds `20261110100000_add_product_slug`. Hannah's merges first. Priya's folder now
sorts before the newest on the base, so the linear-history check fails. Priya
rebases, regenerates the migration, and renames the folder with
`git mv prisma/migrations/20261110090000_add_plan_sort_order prisma/migrations/20261110110000_add_plan_sort_order`.
Her migration never ran on any database, so renaming is safe. Had it already run
on the shared database, she would leave it alone and add a new, later migration
for any correction.

## Sources

- [Migration histories](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/migration-histories) and [schema changes in production](https://www.prisma.io/docs/guides/v7/database/schema-changes).
- [Prisma CLI reference (v7)](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference) — `migrate diff --exit-code`.
