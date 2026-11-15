# 02-availability-and-heatmap (HM-)

Availability editing edge cases and the scheduling grid (heat map) on every page that shows it. This folder checks what the grid shows and lets you pick; what happens after a save (allocation, reschedule outcome) is 03-consultations and 04-subscriptions.

| File | Cases | What |
| --- | --- | --- |
| [01-availability-editing.md](01-availability-editing.md) | HM-01 – HM-14 | Overnight windows and their tails, overlaps, zero-length and 12 h bounds, coalescing (weekly vs custom ids), empty set, custom dates and past dates, schedule-type lock, profile zone convert/keep, snapping, shrinking hours under a booking, stale tabs, window edges, dead vs paid holds |
| [02-grid-canvas-and-states.md](02-grid-canvas-and-states.md) | HM-15 – HM-30 | Grid fixtures, ruled canvas, Open hours / Full day, session blocks, legend and tooltips, the 12 states (past, too soon per lead, limit reached, outside period, this booking, being moved, partly booked, just taken), zone switch, Kathmandu labels, skeleton |
| [03-picking-tray-and-context.md](03-picking-tray-and-context.md) | HM-31 – HM-41 | Hover/focus ghost, whole-session pick and removal, tray progress/picks/meters/warnings, context row, month view "N fit", week navigation, clear/cancel, freshness, "Any time works" |
| [04-surfaces-keyboard-viewports.md](04-surfaces-keyboard-viewports.md) | HM-42 – HM-52 | Allocate, both reschedules, manage timings, free rebook, expert-page dialog; keyboard and screen reader; four viewports; console hygiene; browser vs profile zone |

**Fixtures needed:** F-AV1, F-AV3, F-AV4 (custom, per S-05), F-PL1 (S-08, S-10, S-11), F-BUSY. HM-15 creates **G-SUB** (B1's unallocated 4-week subscription on H1, `[local]`) and **G-REQ** (B2's pending 90-min consultation request on H1). Leave both in the ledger; 03 and 04 may reuse them.

**Run order:** 01-availability-editing first (it restores every host it touches), then HM-15, then 02-b → 02-c → 02-d. HM-25 (Being moved) runs after 03's first consultee reschedule case. HM-46 needs an outage remedy (seeded with owner approval) or is BLOCKED.

**Tags:** `[local]` HM-11, HM-14, HM-15, HM-27; `[two-browser]` HM-12, HM-27.

**Salvaged from `prompts/booking-algorithm-tests/`:** 005 overnight CRUD and overlap clauses (HM-01, HM-02), 005 custom overlap (HM-07); 011 Phase 6 coalescing (HM-04, HM-07), 011 Phases 1–4 dead vs paid hold (HM-14); 014 Phases 3–4 window edges and overnight tail (HM-13). The allocation outcomes of 014 (host-side rule, paused expert, window length) belong to 03.

**Things found while writing this folder** (report them, don't assume):

- The availability PUT has no stale-write guard (HM-12); `SETTINGS_CHANGED` covers only booking-mode settings.
- "Rebook" is the free rebook of an **outage-voided** session, not a rebook of a completed consultation (HM-46).
- `references/availability.md` §9 calls the phone button "Auto-schedule in my open hours"; the code says "Auto-schedule this week" / "Auto-schedule" (HM-49).
- `notEnoughConsecutive` reads "Each session requires 1 hours (2 consecutive slots)" for a 60-min plan (HM-31).
- Trial lengths are 30 or 60 minutes on every new save; only a plan saved earlier with another length (45 exists) can still create off-grid occupancy ("Partly booked", HM-26).
