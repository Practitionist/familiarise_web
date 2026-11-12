# 13-copy-a11y-responsive (UX-)

A copy sweep of every booking surface (truth, usefulness, plain words, raw values, one name per thing); one case per booking error code (code → what the user reads → is there a next step?); a missed-opportunity checklist per surface; keyboard and accessibility-tree passes of the grid, `SingleSessionPicker`, the pattern scheduler, dialogs, checkout and toasts; colour-only signals and contrast (recorded, no palettes); four viewports; zoom; loading, empty and error states.

| File | Cases | Count | What |
| --- | --- | --- | --- |
| [01-surface-copy-sweep.md](01-surface-copy-sweep.md) | UX-01 – UX-14 | 14 | Surface inventory; expert page; checkout; allocate; reschedule; cancel; timings and moves; availability; plan editors; inbox; dashboards; money; back office; one name per thing |
| [02-error-codes-reschedule-cancel-sessions.md](02-error-codes-reschedule-cancel-sessions.md) | UX-15 – UX-44 | 30 | Reschedule codes (window, lead, caps, open, one week, taken, not bookable, proposal shape, pay link live, not reschedulable, no slots, USE_RETIME, USE_SESSION_CANCEL, trial party, platform doors, dispute); cancel codes (in progress, delivered, quote changed, refund window, cancel-door codes); class session codes (not cancellable, make-up window, exists, not skippable, exit); trial booking codes |
| [03-error-codes-scheduling-checkout-events.md](03-error-codes-scheduling-checkout-events.md) | UX-45 – UX-77 | 33 | Event-time and re-time codes; allocator `VALIDATION_ERROR` vs the inbox's sentence; conflicts, locks, timeouts, shortage, idempotency; host and org allocate refusals; feasibility; `NOT_PLACEABLE`'s two meanings; checkout slot codes; plan start; seats, enrolment, waitlist; request caps and leads; self-booking; org checkout; availability contract; grid endpoint; platform refusals; generic fallbacks; reminders |
| [04-missed-opportunities.md](04-missed-opportunities.md) | UX-78 – UX-87 | 10 | Checklists: expert page, checkout, allocate, reschedule, cancel, timings and moves, appointment detail, inbox and Home, money, plan editors and availability |
| [05-a11y-viewports-states.md](05-a11y-viewports-states.md) | UX-88 – UX-100 | 13 | Grid keyboard beyond HM-48; `SingleSessionPicker`; pattern scheduler; dialog focus; checkout; toasts; colour-only grid states; badges; four viewports; zoom and text spacing; loading, empty, error; focus after navigation; reduced motion |

Total: 100 cases.

## Fixtures and personas

No fixtures of its own. It reads the surfaces and triggers the refusals other folders set up; each case names the case whose fixture it reuses (CO-, SU-, WE-, CL-, TR-, HM-, DB-, TZ-). Run it after 02–07 have left their bookings, and alongside 08/09 for the money and race codes.

## Run order

`01` (sweep while you walk the product) → `02` and `03` (trigger each refusal; many are one `fetch` from the signed-in page) → `04` (checklists, per surface) → `05` (keyboard and viewports; one persona per surface). The error-code cases can run inside the journey folders right where the refusal happens; record them here.

## Environment

Previews run almost everything. Codes that need money (`REFUND_QUOTE_CHANGED`, seat and checkout codes) are `[local]`. Platform refusals (UX-75) are preview-only by nature. Browser-zone and format findings belong to 10 (`TZ-35`–`TZ-50`); plurals and units to `TZ-49`; reference them instead of repeating.

## Scope boundaries

02-availability-and-heatmap owns the grid's keyboard model (`HM-48`), legend (`HM-19`), viewports (`HM-49`) and skeleton (`HM-30`); this folder adds what's around the grid. 11 owns notification copy (`DB-63`). 09 owns producing races (`LOCK_LOST`, idempotency); this folder judges their copy.

## Things found while writing this folder (report them, don't assume)

- The inbox maps `VALIDATION_ERROR` to "That request could not be read. Refresh and try again.", hiding the allocator's plain rule sentence (UX-48).
- `NOT_PLACEABLE` is both a checkout refusal and a reschedule success outcome (UX-62); `IDEMPOTENCY_KEY_REUSED` vs `IDEMPOTENCY_KEY_REUSE`; `USE_CANCEL_ENDPOINT` vs `USE_CANCEL_ROUTE`.
- Developer text in server sentences that may surface: "Use POST /api/appointments/{appointmentId}/cancel instead." (UX-37), "(1 confirmed slot(s) exist)" (UX-50), "(expected 2 held, found 1)" (UX-51), "pass `personal` or a specific orgId" (DB-22), "Window 1: times must be whole minutes from 0 to 1439" (UX-73), "(canSponsor=false)" (UX-72).
- "Times start on the hour or half hour" / "Pick a start time on the hour or half hour." is false for :15/:45 zones (UX-45, UX-63).
- "You already have this plan with N sessions left — schedule those first." asks the buyer to do the expert's job (UX-66).
- "All sessions selected … Click 'Allocate' to confirm." is a red toast for a success, naming a button called Save (UX-04).
- The proposal card titles `SESSION_NOT_CANCELLABLE` "This session can no longer be rescheduled" (UX-39); the inbox calls a length mismatch "changed elsewhere" (UX-24).
- Pattern-scheduler row controls are named "Day 1", "Time 1" (UX-90).
