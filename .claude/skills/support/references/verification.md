# Verifying a support change

## Fast checks

- Typecheck: `npx tsc --noEmit`. Lint: `npm run lint`. Format the files you touched: `npx prettier --write <files>`.
- Targeted Jest (mocked Prisma; proves app checks, not the sidecar):
  - lifecycle: `npx jest __tests__/support/lifecycle-transitions.test.ts __tests__/support/lifecycle-case-service.test.ts __tests__/support/lifecycle-routes.test.ts __tests__/support/lifecycle-service.test.ts`
  - decisions and money: `npx jest __tests__/support/lifecycle-decisions.test.ts __tests__/support/case-money-hardening.test.ts __tests__/support/case-action-claims.test.ts __tests__/backoffice/support-money-doors.test.ts __tests__/backoffice/ops-proposals.test.ts`
  - holds: `npx jest __tests__/support/case-holds.test.ts __tests__/support/case-hold-lifecycle.test.ts`
  - sweep: `npx jest __tests__/support/sla-sweep-lifecycle-arms.test.ts __tests__/support/problem-cascade.test.ts __tests__/support/evidence-retention.test.ts __tests__/support/dispute-deadline-alerts.test.ts`
  - access and routes: `npx jest __tests__/support/case-access.test.ts __tests__/support/route-authz-matrix.test.ts __tests__/support/evidence-route-authz.test.ts __tests__/security/org-support-threads-sensitive.test.ts`
  - privacy: `npx jest __tests__/compliance/support-privacy-export.test.ts __tests__/compliance/support-erasure.test.ts`
  - intake: `npx jest __tests__/support/service.test.ts __tests__/support/platform-route.test.ts __tests__/support/case-intake-scope.test.ts __tests__/support/flow-walk.test.ts`
  - chat access: `npx jest __tests__/support/chat-doors.test.ts __tests__/support/chat-transcript.test.ts __tests__/support/chat-access-eligibility.test.ts __tests__/support/sla-sweep-chat-arm.test.ts __tests__/stream/support-intervention.test.ts`
- A new route belongs in `__tests__/support/route-authz-matrix.test.ts`.

## Database race tier

- Files: `__tests__/db/support/*.db.test.ts` (decision race, intake scope, problem cascade, refund claim, turn replay). Config: `jest.db.config.ts`; guard: `__tests__/db/guard.ts`.
- Runs in CI, or locally per booking verification §11 (`.claude/skills/booking/references/verification.md`). The CI `db-guards` job (`.github/workflows/ci.yaml`) does: Postgres 17, schema pushed, `npm run db:sidecars`, `scripts/ci/check-db-sidecars.ts`, then `jest -c jest.db.config.ts`.
- The guard refuses unless `CI=true` and `DATABASE_URL` is a local `/ci` database. Do not bypass it; never point it at the shared database.
- Add a `.db.test.ts` when a rule depends on a sidecar object or on real concurrency; mocked tests cannot prove either.

## Schema changes

- Edit `prisma/schema.prisma`, then `npx prisma generate`. Put CHECKs, partial uniques and triggers in `prisma/sql/check-constraints.sql`.
- Read-only drift check: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`. Never `db push`.
- List the exact DDL in the PR body; the owner applies it at the end (`docs/support/12-runbooks.md#ddl-end-phase-checklist`).

## Docs

- Update the matching `docs/support/` page and this skill in the same PR. Run `npx tsx scripts/ci/check-docs-drift.ts` and validate Mermaid blocks you touched with `npx -y @mermaid-js/mermaid-cli -i <file> -o /tmp/out.svg`.
