# 04 · Subscriptions (`SU-`)

1:1 plans sold as N weeks (or legacy N months) × S sessions a week: the plan editor and its publish-time feasibility gate, checkout with the room hint and `NOT_PLACEABLE`, scheduling one plan week at a time (auto and manual, partial weeks), the weekly cap at every door, single-session moves and returns, cancelling the plan, plan end, renewal, and an expert who runs out of hours.

Read `../README.md` and `../_shared/*.md` first. Cases reference personas, fixtures and recipes by name.

## Files

| File | Cases | Count | Needs |
| --- | --- | --- | --- |
| [`plan-editor/01-cadence-and-length.md`](plan-editor/01-cadence-and-length.md) | SU-01 – SU-10 | 10 | F-AV1, F-AV2, F-PL1 |
| [`plan-editor/02-feasibility.md`](plan-editor/02-feasibility.md) | SU-11 – SU-22 | 12 | F-AV1, F-AV2, F-AV4 |
| [`checkout/01-buy-room-hint-and-org.md`](checkout/01-buy-room-hint-and-org.md) | SU-23 – SU-34 | 12 | F-PL1, F-BUSY, `qa-SU-14`, `qa-SU-17`, Wipro billing/Program/assignment/consent; `[local]` |
| [`allocation/01-first-week-and-partial.md`](allocation/01-first-week-and-partial.md) | SU-35 – SU-50 | 16 | SU-23, SU-27, P-B1, F-BUSY, SU-20 booking |
| [`allocation/02-week-pacing-and-quota-doors.md`](allocation/02-week-pacing-and-quota-doors.md) | SU-51 – SU-60 | 10 | SU-35, SU-37; clock shifts |
| [`lifecycle/01-reschedule-and-return.md`](lifecycle/01-reschedule-and-return.md) | SU-61 – SU-71 | 11 | SU-37, SU-51; clock shifts |
| [`lifecycle/02-cancel.md`](lifecycle/02-cancel.md) | SU-72 – SU-77 | 6 | fresh purchases; `[local]` |
| [`lifecycle/03-plan-end-renewal-unavailable.md`](lifecycle/03-plan-end-renewal-unavailable.md) | SU-78 – SU-85 | 8 | `[sweep]` jobs, clock shifts |

Total: 85 cases.

## Fixtures and personas

- **Hosts:** H1 (IST, F-AV1) sells the main plans; H2 (IST, F-AV2: Mon/Wed/Fri evenings, Tue/Thu mornings) for tight and infeasible plans; H4 (Asia/Kathmandu, F-AV4) for the half-hour lattice and empty-week cases. Never change F-AV1. Restore F-AV2 and F-AV4 after any case that changes them.
- **Buyers:** B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), DR (Australia/Sydney) so each case has a concrete "the other side sees" conversion. B4/DR + OS for org-funded plans.
- **Plans created here:** `qa-SU-14` (H2, 3/week × 2.5 h) is reused by SU-20, SU-27 and SU-45–SU-50; `qa-SU-17` (H4, 1/week × 1 h) by SU-28. Keep both until SU-85.
- **Months plan:** F-PL1's months plan. New plans in the editor are always weeks plans; if 01 had to create the months plan through the API, note it in the report.

## Run order

1. `plan-editor/` (no money).
2. `checkout/01` (`[local]` purchases create the plans the rest of the folder uses).
3. `allocation/01` → `02`.
4. `lifecycle/01` → `02` → `03` (`03` shifts clocks and needs jobs; run it last).

## What this folder does not cover

Grid mechanics (02 `HM-`), trials and trial conversion (07 `TR-`), refund and earnings arithmetic in depth (08 `MO-`), races and idempotency depth (09 `CC-`), DST and zone matrices (10 `TZ-`), notification and role matrices (11 `DB-`), sweep batching and retries (12 `SW-`), the copy and a11y sweep (13 `UX-`). Cases here still assert the immediate money, dashboard and zone outcome of each journey.

## Salvaged from the old suite

- `e2e-booking-agent-003` (auto-allocate edge cases): the "period too tight" and "auto spreads within the weekly cap" ideas became SU-35, SU-36 and SU-45 (now plan-week rules, not period rules). Its webinar and class parts are 05/06 material.
- `e2e-booking-agent-012` (partial allocation): Phase 1 (refusal carries `placeableSessions`) → SU-45; Phase 2 (`allowPartial` places what fits) → SU-45; Phase 3 (only the host may choose partial) → SU-46; Phase 5 (consultee is told) → SU-45/SU-49. Phase 4's "manual ignores `allowPartial`" is no longer true: SU-47 tests the new behaviour. The co-host phases belong to 05/06.
- `e2e-booking-agent-020` (return a session): Phase 1 → SU-68; Phase 2 → SU-69. The strike phases moved to SU-74 (expert cancel) and 03/11.
