# Supabase and Prisma Migrate

This reference covers what changes when the database behind Prisma Migrate is a
Supabase project: which connection mode to use for which command, which timeouts
apply, whether to use Supabase branching, what the free plan does and does not
protect, and which Supabase tools must never touch the app schema. This
repository's connection variables are described in `this-repo.md`.

## Connection modes

Supabase offers three ways in ([connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)).

| Mode               | Address                                                          | Notes                                                                                                |
| ------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Direct             | `db.<ref>.supabase.co:5432`                                      | IPv6-only on the Free and Pro plans unless the IPv4 add-on is bought.                                |
| Session pooler     | `aws-N-<region>.pooler.supabase.com:5432`, user `postgres.<ref>` | IPv4. Behaves like a normal session, so `SET`, prepared statements and session advisory locks work.  |
| Transaction pooler | the same host on port `6543`                                     | No prepared statements, no session-level `SET`, no session advisory locks. For the app runtime only. |

`prisma migrate deploy` takes a session advisory lock, so it must use the session
pooler or the direct address and never port 6543
([Supabase and Prisma](https://supabase.com/docs/guides/database/prisma)). This
repository's `DIRECT_URL` is the session pooler, and `prisma.config.ts` binds the
Prisma CLI to it. The app runtime uses the pooled `DATABASE_URL`.

GitHub Actions runners are IPv4-only, so a CI job that runs `migrate deploy` must
use the session pooler, not the direct address
([IPv4 and IPv6 compatibility](https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP)).

## Timeouts

Supabase documents per-role statement timeouts ([timeouts](https://supabase.com/docs/guides/database/postgres/timeouts)):
`anon` is 3 seconds, `authenticated` is 8 seconds, and `postgres` has no role
value, so the global cap applies. The Dashboard SQL editor caps at 60 seconds.
No `lock_timeout` default is documented, and the PostgreSQL defaults for both
`statement_timeout` and `lock_timeout` are 0, meaning no limit
([PostgreSQL 15 client settings](https://www.postgresql.org/docs/15/runtime-config-client.html)).

Two consequences for migrations:

- A migration with no `lock_timeout` can queue behind an open transaction
  forever. Set one at the top of every migration that takes an `ACCESS EXCLUSIVE`
  lock (see `prisma-mechanics.md` on `SET` versus `SET LOCAL`).
- `lib/prisma.ts` sets `statement_timeout` for the app runtime only. The Prisma
  CLI does not pass through that code, so a CLI migration runs with whatever the
  server and role provide.

## Branching: not recommended here

Supabase branching is available on the Pro plan only and costs about $0.01344 per
branch-hour; branch compute is not covered by the spend cap
([pricing](https://supabase.com/pricing),
[branching usage](https://supabase.com/docs/guides/platform/manage-your-usage/branching)).
Branches are built from the repository's Supabase migrations, and the
documentation does not say how that works for a project whose history lives in
`prisma/migrations` (UNVERIFIED;
[branching guide](https://supabase.com/docs/guides/deployment/branching)).

Recommendation: do not adopt branching. Use a second Supabase project for
development, as planned in `docs/deployment/db-split-plan.md`.

## Free plan limits

The free plan allows two active projects, pauses a project after one week of
inactivity, offers 500 MB of database storage, and takes no automatic backups.
The Pro plan keeps seven daily backups
([pricing](https://supabase.com/pricing),
[backups](https://supabase.com/docs/guides/platform/backups)). Take a manual
`pg_dump`, and prove it restores, before the last guarded `db push` of the
cutover and before the first production migration while the project is on Free.
These figures are public plan terms and may have changed; re-check them on the
pricing page before relying on them.

## A dedicated `prisma` role

Supabase recommends creating a dedicated `prisma` role for Prisma instead of
using `postgres` ([Supabase and Prisma](https://supabase.com/docs/guides/database/prisma)).
Before switching, check who owns the existing tables, enums, views and functions:
objects owned by `postgres` may not be alterable by a new role (UNVERIFIED
inference; confirm with `\dt+` and `\dT` on a scratch copy). Creating a role is a
database write, so the owner decides and runs it.

## Never use the Supabase MCP `apply_migration` for app schema

The MCP `apply_migration` tool records the change in Supabase's own migration
history, not in Prisma's `_prisma_migrations` table (inference from the two
tools' separate bookkeeping; UNVERIFIED). A schema changed that way leaves
Prisma and the database disagreeing about history. App schema changes go through
`prisma/schema.prisma` and a Prisma migration. The Supabase write rules for this
repository are in `prisma/AGENTS.md`.

## Sources

- [Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) and [Prisma on Supabase](https://supabase.com/docs/guides/database/prisma) — connection modes and the dedicated role.
- [IPv4 and IPv6 compatibility](https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP) — why CI needs the session pooler.
- [Timeouts](https://supabase.com/docs/guides/database/postgres/timeouts) and [PostgreSQL 15 client settings](https://www.postgresql.org/docs/15/runtime-config-client.html) — role timeouts and defaults.
- [Pricing](https://supabase.com/pricing), [backups](https://supabase.com/docs/guides/platform/backups), [branching usage](https://supabase.com/docs/guides/platform/manage-your-usage/branching) and [branching](https://supabase.com/docs/guides/deployment/branching).
