# Case file template

Every case file in `prompts/booking-qa/NN-*/` follows this shape. Writers: keep it; runners: expect it.

````markdown
# NN-x · <Area>: <short title>

**Needs:** fixtures (F-AV1, F-PL1 …), earlier cases, environment (local for mock pay / preview OK).
**Personas:** H1 (IST), B2 (Europe/London) …
**Docs under test:** `docs/booking/…`, `.claude/skills/booking/…`

## <CaseID> — <title>

**Why it matters:** one sentence on the user or money risk.

**Setup:** UI steps first; SQL only with a reason (owner approval).

**Steps:**

1. As B1 (IST), open … click … read …
2. …

**Expect:**

- UI: exact state, copy that must appear (or must not), enabled/disabled controls with their reason.
- API: `METHOD /path` → status, `code`.
- DB: recipe R-0x → expected rows.
- Money: amounts in ₹ and paise, refund rows, earnings.

**Cross-check:** the surfaces that must agree (consultant, consultee, org, staff, bell, outbox) and the other party's zone.

**Probe further (report anything odd):** what the user would try next; edge variants worth a quick try; copy and missed-opportunity prompts.
````

Rules for case writers:

- One behaviour per case. A case ID is `<folder letter>-<nn>` (see the README) and never reused.
- Every case says what the user **sees** and what the DB **holds**.
- Give exact error codes and HTTP statuses where the contract defines them. Where the contract is unknown, say "expect a typed 4xx with a human message" and let the runner report what came back.
- Don't paste huge SQL; reference recipes `R-01…R-09` in [sql-recipes.md](sql-recipes.md).
- Mark cases that need mock payment `[local]`, background jobs `[sweep]`, and two simultaneous browsers `[two-browser]`.
