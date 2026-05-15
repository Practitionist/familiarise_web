# 2-programs-contracts — API: LICENSED_SEAT + CREDIT_POOL

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `app/api/organizations/[orgId]/programs/route.ts` — POST (LICENSED_SEAT, CREDIT_POOL); GET (list)
- `app/api/organizations/[orgId]/programs/[programId]/route.ts` — PATCH, DELETE
- `app/api/organizations/[orgId]/contracts/route.ts` — POST (DRAFT → ACTIVE)
- `prisma/schema.prisma model Program` — `type` discriminated subtypes
- `prisma/schema.prisma model LicensedSeatConfig` — `ratePerSeatPaise`, `cycle`, `coveredEngagementsPerCycle`, `overageBehavior`
- `prisma/schema.prisma model CreditPoolConfig` — `creditValuePaise`, `premiumMultiplier`, `minimumCreditsPerPeriod`
- `prisma/schema.prisma model BookingUtilization` — `engagementsConsumed`, `reversedAt`

**Case roster:**
1. **PR.1** — Create LICENSED_SEAT program (cycle + rate + cap + overage=BLOCK)
2. **PR.2** — Create CREDIT_POOL program
3. **PR.3** — Reject CREDIT_POOL on LICENSE-funded contract (`BOGUS_LICENSE_CREDIT_POOL`)
4. **PR.4** — `coveredEngagementsPerCycle = null` → unlimited
5. **PR.5** — Overage BLOCK: at-cap booking → 409
6. **PR.6** — Overage CHARGE_ORG: writes `PaymentLeg(source=OVERAGE_INVOICE_ACCRUAL)`
7. **PR.7** — ProgramAssignment unique on `(programId, membershipId, periodStart)`
8. **PR.8** — BookingUtilization.reversedAt round-trip (refund flow)

---

## Common preconditions

Wipro (SPONSOR + INVOICE) from seed. OWNER session. Capture
`<wipro-id>`, `<billingAccountId>`, `<contractId>` (DRAFT or ACTIVE).

Cleanup:
```sql
DELETE FROM "Program" WHERE "contractId" = '<contractId>' AND name LIKE 'Test PR.%';
```

---

## Case PR.1: LICENSED_SEAT happy path

```js
() => fetch("/api/organizations/<wipro-id>/programs", {
  method: "POST", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({
    type: "LICENSED_SEAT",
    contractId: "<contractId>",
    name: "Test PR.1 LICENSED_SEAT",
    coveredPlanTypes: ["CONSULTATION"],
    allowedCategories: [],
    licensedSeatConfig: {
      ratePerSeatPaise: 200000,
      cycle: "MONTHLY",
      coveredEngagementsPerCycle: 4,
      overageBehavior: "BLOCK"
    }
  })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 201`
- `body.data.type === 'LICENSED_SEAT'`
- DB `Program` row + 1:1 `LicensedSeatConfig` row.
- Audit: `PROGRAM_CREATED`.

---

## Case PR.2: CREDIT_POOL happy path

```js
{
  type: "CREDIT_POOL",
  contractId: "<contractId>",
  name: "Test PR.2 CREDIT_POOL",
  creditPoolConfig: {
    cycle: "QUARTERLY",
    creditsPerCycle: 100,
    minimumCreditsPerPeriod: 0
  }
}
```

### Assertions
- `status === 201`, `CreditPoolConfig` row exists.

---

## Case PR.3: Reject CREDIT_POOL under LICENSE contract

Set Wipro's `BillingAccount.fundingSource = 'LICENSE'` for this case:
```sql
UPDATE "BillingAccount" SET "fundingSource" = 'LICENSE'
WHERE id = '<billingAccountId>';
```

Then attempt to create a CREDIT_POOL program. Expect:
- `status === 400`
- `body.code === 'BOGUS_LICENSE_CREDIT_POOL'`
- No row created.

Restore `fundingSource = 'INVOICE'` after the case.

---

## Case PR.4: Unlimited (coveredEngagementsPerCycle = null)

POST a LICENSED_SEAT program with `coveredEngagementsPerCycle: null`.
Expect 201. Subsequent bookings should never hit the cap.

Verify with a `BookingUtilization` insertion sequence — debit 100 times,
no `wasOverage = true` row appears.

---

## Case PR.5: Overage = BLOCK → 409 at cap

Setup: `coveredEngagementsPerCycle = 1`, `overageBehavior = 'BLOCK'`.
Assign program to a member. First booking succeeds; second booking
should 409 with `PROGRAM_CAP_EXHAUSTED`.

```js
() => fetch("/api/checkout", { method: "POST", credentials: "include", ... })
  .then(async r => ({ status: r.status, body: await r.json() }))
// Second call: 409
```

### Assertions
- First booking: `BookingUtilization` row exists, `engagementsConsumed = 1`.
- Second booking: 409 + `code` matches the error map at
  `app/api/organizations/[orgId]/programs/route.ts`.

---

## Case PR.6: Overage = CHARGE_ORG → OVERAGE_INVOICE_ACCRUAL leg

Same setup as PR.5 but `overageBehavior = 'CHARGE_ORG'`.

Second booking succeeds. Verify:
```sql
SELECT source, "amountPaise" FROM "PaymentLeg"
WHERE "paymentId" = '<second-payment-id>';
-- Expected: at least one row with source='OVERAGE_INVOICE_ACCRUAL'
```

The leg is what accrues onto the next OrganizationInvoice rollup.
Without this row, the org is silently absorbing the overage as platform
cost — bug. NON-TRIVIAL — ASK.

---

## Case PR.7: ProgramAssignment unique

Assign the same program to the same membership for the same
`periodStart` twice:
```sql
INSERT INTO "ProgramAssignment" ("programId", "membershipId", "periodStart", "periodEnd", "engagementsUsed", "overageCount", "createdAt", "updatedAt")
VALUES ('<programId>', '<membershipId>', '2026-05-01', '2026-05-31', 0, 0, now(), now());

-- Second insert with same (programId, membershipId, periodStart):
INSERT INTO "ProgramAssignment" (...) VALUES (...) ; -- Expected: P2002 / 23505
```

The second attempt must fail at the DB layer.

---

## Case PR.8: Refund → BookingUtilization.reversedAt

Refund an existing booking:
```js
() => fetch("/api/refunds", {
  method: "POST", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({ paymentId: "<paymentId>", reason: "test refund" })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
```sql
SELECT "reversedAt", "reversalReason", "engagementsConsumed"
FROM "BookingUtilization" WHERE "paymentId" = '<paymentId>';
-- Expected: reversedAt IS NOT NULL, reversalReason set, engagementsConsumed unchanged
```

Plus a counter `UsageLedgerEntry` with negative `engagementsConsumed`.

**Regression signal:** if `BookingUtilization` row is *deleted* instead
of marked reversed, history is destroyed. NON-TRIVIAL — ASK.
