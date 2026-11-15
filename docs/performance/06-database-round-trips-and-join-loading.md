# Database round trips and join loading

This document describes how the dashboard readers under `lib/data/` load related rows, why the number of SQL statements matters more than their speed, and which conventions keep that number low. It applies to every server read that runs on Netlify against the shared Supabase database.

## Why statement count dominates

Every Netlify function instance holds exactly one Postgres connection, because `PG_POOL_MAX=1` is a deploy invariant (`lib/prisma.ts`). Concurrent Prisma calls therefore queue behind each other, and `Promise.all` over independent reads does not overlap them. The functions run in the `sin` region and the database runs in `ap-south-1`, so each statement costs about 95 ms of wall time on a deploy preview, while Postgres itself usually executes it in under 6 ms. Measured locally against the same database, a statement costs about 40 ms.

The consequence is that a request's database time is roughly the number of statements multiplied by the round-trip cost. Row counts and column widths barely register until a payload grows past a few hundred kilobytes. A reader that touches twenty relation nodes costs about two seconds on Netlify even when every table holds ten rows.

## How Prisma turns a nested read into statements

By default Prisma uses the `query` relation load strategy. It sends the parent `SELECT`, then one further `SELECT ... WHERE fk IN (...)` for every relation node in the `include` or `select` tree, and merges the results in the application. The statements are batched by relation, so this is not a per-row N+1, but it is one round trip per relation node.

A `_count` selection is compiled differently under this strategy. Prisma emits `LEFT JOIN (SELECT fk, COUNT(*) FROM child GROUP BY fk)` with no filter on the parent, so every count aggregates the whole child table. On `orgDetailsInclude` this meant five whole-table aggregates, including the unbounded `OrgAuditLog`, on every organisation page load.

## Join loading

Prisma ORM 7.10 ships join loading as the `relationJoins` preview feature, which `prisma/schema.prisma` enables. With the `join` strategy, Prisma sends one statement per read. On PostgreSQL it builds each relation with a `LEFT JOIN LATERAL` subquery that aggregates the child rows into JSON in the database. A `_count` becomes a per-parent `LATERAL (SELECT COUNT(*) ... WHERE child.fk = parent.id)`, so it no longer scans whole tables.

The preview flag makes `join` the default for every query once it is on. `lib/prisma.ts` therefore registers a query extension that sets `relationLoadStrategy: "query"` on every `find*`, `create`, `update`, `upsert` and `delete` call that does not choose a strategy itself. Every query keeps its previous behaviour, and a reader opts in by passing `relationLoadStrategy: "join"` at the top level of its call. Prisma falls back to `query` on its own when the read uses a `cursor`, so a reader that paginates by cursor does not need special handling.

The strategy is chosen per query rather than globally for three reasons. First, the feature is still in preview. Second, Prisma has open issues about join loading that this schema could hit: Decimal precision loss in related records (`@db.Decimal(18, 6)` columns exist on the FX and tax models) and slower plans for some deeply nested joins. Third, a per-query choice is verified one reader at a time against a payload snapshot, while a global switch would change hundreds of reads at once.

### When to opt in

**Rule:** use `relationLoadStrategy: "join"` for list and detail reads with nested relations, and on a write path only for the named booking reads in [Booking write paths](#booking-write-paths). `lib/prisma.ts` keeps `"query"` as the default because `relationJoins` is a Prisma 7 preview feature, and that default stays for as long as the app is on Prisma 7. Prisma 8 loads `include` in one statement by design, and moving to it is a separate migration.

A reader should pass `relationLoadStrategy: "join"` when it runs on a request path and its `include` or `select` tree has three or more relation nodes. It also applies to any read that selects `_count`. Money columns are safe: BigInt columns travel through the JSON aggregation as text and come back as the same BigInt values, and the result extensions in `lib/prisma-extensions.ts` still convert them. Aggregates (`count`, `aggregate`, `groupBy`) do not accept the option, and do not need it. Do not opt in a read that selects a `Decimal` column while the upstream precision issue is open; none of the readers below selects one. `Payment.exchangeRateAtCheckout` is the one to watch: the pending-payments gateway read therefore uses an explicit `select` instead of `include`.

Before opting a reader in, snapshot its payload with the query strategy and compare it with the join strategy. `tests/typescript/join-loading-parity.ts` does this for one money read on every push to `dev` (the live-database job in `.github/workflows/race-condition-tests.yml`). It is read-only: it asserts that both strategies return deeply equal money values, Dates, nulls and nested list order for an existing payment, and it checks the money mapping above 2^31 paise with a selected literal, because no stored value is that large. Every reader listed below produced a byte-identical payload under both strategies against the shared database.

### Readers that use join loading

| Reader                                                                                                                     | File                                                                                    | Statements before                                        | Statements after                  |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| Session enrichment (`customSession` memberships), on every authenticated request                                           | `lib/auth.ts`                                                                           | 6 for the whole session read                             | 3 for the whole session read      |
| Consultant Home appointments, pending lists, active book, next cycles                                                      | `lib/data/consultant-dashboard.ts`                                                      | 94 for the whole Home payload                            | 33 for the whole Home payload     |
| Learner events (Home and Appointments)                                                                                     | `lib/data/consultee-events-read.ts`                                                     | 51                                                       | 6                                 |
| Appointment detail                                                                                                         | `lib/data/appointment-detail.ts`                                                        | 53                                                       | 1                                 |
| Consultant appointments list                                                                                               | `lib/data/consultant-appointments.ts`                                                   | 29                                                       | 1                                 |
| Earnings history rows and attribution                                                                                      | `lib/payments/payouts/earnings-service.ts`, `lib/data/consultant-earnings-analytics.ts` | part of the Earnings page                                | part of the Earnings page         |
| Dashboard layout user seed                                                                                                 | `lib/data/user-details.ts`                                                              | 8                                                        | 1                                 |
| Organisation details (layout seed and API)                                                                                 | `lib/data/org-details-server.ts`, `app/api/organizations/[orgId]/route.ts`              | 5                                                        | 1                                 |
| Consultee pending payments (four reads: consultations, subscriptions, gateway payments, trials)                            | `app/api/dashboard/consultee/[consulteeId]/pending-payments/route.ts`                   | about 36 (reasoned)                                      | 4                                 |
| Explore expert cards (curated rows, default page, list API)                                                                | `lib/data/explore-experts.ts`, `app/api/user/consultants/route.ts`                      | 12 per read (reasoned)                                   | 1 per read                        |
| Staff appointments list                                                                                                    | `lib/data/staff-appointments.ts`                                                        | about 18 (reasoned)                                      | 1                                 |
| Explore filter metadata (domains with subdomains, tags and verified-consultant counts)                                     | `lib/data/explore-experts.ts` (`fetchExpertsMetadata`)                                  | 4 (domains, subdomains, tags, counts)                    | 1                                 |
| Reviewable sessions (consultee review card and POST authorization)                                                         | `lib/reviews.ts` (`loadReviewableAppointments`)                                         | about 12 (reasoned)                                      | 1                                 |
| Taxonomy lists (domains with sub-domains and tags, tags, sub-domains), served from the data cache under the `taxonomy` tag | `lib/data/taxonomy.ts`, `app/api/user/content/{domains,subdomains,tags}/route.ts`       | 3 per domains request, 2 per tags or sub-domains request | 0 on a cache hit, 1 on a miss     |
| Organisation access check                                                                                                  | `lib/auth-helpers.ts` (`requireOrgAccess`)                                              | 2 per call                                               | 1 per render for the organisation |

The rows with a reasoned count were not measured against a database; the counts come from the number of relation nodes in each `include` or `select` tree (each node is one statement under `query`). The Earnings page as a whole dropped from 104 statements to 27. The three statements left in the session read are Better Auth's own session and user lookups and the joined membership read. Better Auth's `experimental.joins` option did not merge the first two through the Prisma adapter when tried, so they stay separate.

**Tiny reference tables are cached, not just joined.** The `Domain`, `SubDomain` and `Tag` lists change only on an admin or consultant write, so `lib/data/taxonomy.ts` serves them from `unstable_cache` under the tag `taxonomy` and every write path calls `purgeTaxonomy()` after it commits (the consultant custom-tag upsert in `app/api/user/content/tags/route.ts`). The cached rows carry ids and names only, so no `Date` crosses the cache. The consultant-count variants on the landing page and explore filters stay under the `experts` tag.

### Booking write paths

The booking writes are where statement count hurts most, because several of their reads run inside a Serializable or interactive transaction that holds the connection. The reads below opt in by name; their selections are unchanged, so callers receive the same rows. `ensureConsulteeProfile` and the trial `create` read-back are in the list because a write helper's read is still a read. The reasoning and the options not chosen are in [the booking statement cuts](../decisions/2026-11-15-booking-statement-cuts.md).

| Path                       | Joined reads (file)                                                                                                                                                                                                                                                                | Other cut                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Free webinar seat checkout | the four webinar loads (`lib/payments/checkout/pricing.ts`, `locks.ts`, `revalidate.ts`, `handlers/webinar.ts`), `resolvePaymentForEarnings` (`lib/payments/payouts/earnings-service.ts`), `classifyOpenOrders` (`lib/payments/checkout/order-reuse.ts`), `ensureConsulteeProfile` | the consumer-invoice reads are skipped when `hasBilledSupply` is false                 |
| Free trial request         | the `trial.create` read-back (`lib/trials/book-trial.ts`), the bell recipients (`bellRecipientZones`)                                                                                                                                                                              | notice reads before the transaction, one insert per table inside it, `timeout: 15_000` |
| Cancel a 1:1               | the route's appointment read, `resolveBookingRefundContext` (`lib/booking/cancellation-scope.ts`), the backup-interest read (`lib/booking/backup-interest.ts`)                                                                                                                     | none                                                                                   |
| Leave an event seat        | `seatPayment` (read once per leave, `lib/booking/seat-leave.ts`), `readEventByAppointment` (`lib/booking/event-waitlist.ts`), the payment read in `refundRemovedAttendeeSeat`                                                                                                      | none                                                                                   |

Counts per path, before and after (static traces every Prisma call; measured is the database-tier statement log; `BEGIN`, `COMMIT` and `SET TRANSACTION` count):

| Path                                                    | Before | After | Source   |
| ------------------------------------------------------- | ------ | ----- | -------- |
| Free webinar seat checkout, `handleCheckout`            | 129    | 76    | measured |
| of which inside the Serializable commit                 | 58     | 37    | measured |
| Free 1:1 consultation checkout, `handleCheckout`        | 127    | 93    | measured |
| Free trial request, the route                           | 46     | 29    | measured |
| of which inside its transaction                         | 37     | 18    | measured |
| `bookTrialInTx` alone, with `BEGIN` and `COMMIT`        | 21     | 16    | measured |
| Cancel a free confirmed 1:1, the route                  | 52     | 21    | measured |
| Leave a paid webinar seat, the committed leave          | 39     | 18    | measured |
| `resolvePaymentForEarnings`'s read on a webinar payment | 17     | 1     | measured |

A path's time is its count times about 95 ms, so a free webinar registration drops from about 12.3 s to about 7.2 s of round trips (measured with a mocked session and gateway; the refund door and the Stream calls are not in these counts). A booking write's interactive `$transaction` passes `maxWait` and `timeout`; Prisma's 5 s default is not a budget for a transaction of 30 statements.

## Companion conventions

**Select what the view renders.** An `include` on a plan or a `ConsultantProfile` reads every column of that row, including tax and bank fields the view never shows, and ships them into the dehydrated HTML. Readers should `select` the fields their transform and client helpers actually read. The consultant Home appointment read now selects plan titles, the entitlement inputs, the owner's avatar and the accepted collaborators, and nothing else.

**Resolve a request's shared reads once per render.** Next renders a layout and its page in the same React render, and both often run the same guard. `lib/render-memo.ts` wraps a reader in React's `cache` inside the RSC layer and returns the plain function elsewhere, such as in jobs, tests and route handlers. `getSession` and the organisation and membership lookups in `requireOrgAccess` use it, so an organisation page resolves its access check once instead of three times.

**Merge aggregates that share a filter.** Aggregates cannot be joined, so each one is a round trip. Sums over the same rows with different status filters belong in one `groupBy({ by: ["status"] })`, with the buckets summed in JavaScript. Consultant Home reads Net, Ready and Available earnings from one grouped query.

**Build a page's seeds in one pass.** When two cache entries on one page share their reads, the page builds both from one pass and seeds them with `setQueryData`. The Earnings page builds its Summary and Analytics bodies with `buildConsultantEarningsPagePayloads`, which returns exactly what `GET /api/consultant/earnings` answers for each view.

**Seed the layout with the shell's fields only.** The dashboard layout seeds `["user-details", userId]` with `getShellUserDetails`, which omits work history, education and certifications. The settings pages load those lists under their own query keys.

## Measuring a reader

Count statements at the `pg` driver rather than through Prisma's query event, because the extended client does not expose `$on`. A temporary script in the worktree root can patch `pg.Client.prototype.query` to increment a counter, import the reader through the `@/` alias, and run it three times after one warm-up call. Run it with `PG_POOL_MAX=1` and a preload that stubs `server-only`, for example `NODE_OPTIONS="--require <stub>.cjs" npx tsx --env-file=.env <script>`. Never commit the script.

## References

- Prisma, relation load strategies (Preview): https://www.prisma.io/docs/orm/v7/prisma-client/queries/relation-queries#relation-load-strategies-preview
- Prisma query compiler support for `relationJoins`: https://github.com/prisma/prisma-engines/pull/5374
- Strategy selection in the query compiler (`get_relation_load_strategy`): https://github.com/prisma/prisma-engines/blob/main/query-compiler/core/src/query_graph_builder/read/utils.rs
- Open issue, Decimal precision with `relationJoins`: https://github.com/prisma/orm/issues/25639
- Open issue, overhead in nested joins: https://github.com/prisma/orm/issues/22596
- Prisma, currently active Preview features (`relationJoins` since 5.7.0): https://www.prisma.io/docs/orm/reference/preview-features/client-preview-features
- Prisma, release status (Prisma 8 release candidate, unsupported features, Prisma 7 support window): https://www.prisma.io/docs/orm/release-status

## Deprecated & Superseded Approaches

Earlier performance work parallelised independent Prisma reads with `Promise.all` on the assumption that they would overlap. Under `PG_POOL_MAX=1` they serialise, so that change bought nothing; statement count is the lever that responds. Readers also used whole-row `include` on plans and profiles, which multiplied relation nodes and shipped unused columns to the client. The organisation details read used `_count` under the query strategy, which aggregated whole child tables on every page load. The Earnings page built its earnings payload twice and prefetched the full consultant appointments list, and the dashboard layout seeded the full résumé on every page. All of these have been replaced by the conventions above.
