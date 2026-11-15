# 13-a · Copy: every booking surface, terminology and AI slop

**Needs:** the bookings and plans other folders leave (any state per surface). No money moves in this file.
**Personas:** H1, H2, H3, B1, B2, OS, ST.
**Docs under test:** `_shared/reporting.md` §2 (COPY / AI-SLOP, FALSE-INFO, MISSED-OPPORTUNITY), the ADR's copy decisions, `components/dashboard/shared/requests/labels.ts`, `lib/scheduling/allocationMessages.ts`, `lib/booking/allocation/refusal-copy.ts`.

**How to sweep a surface:** take a snapshot (`take_snapshot`) and read every visible string, every tooltip (`hover`), every `aria-label`, every toast you can trigger without side effects, and the empty, loading and error states. For each string decide:

1. **True?** Check numbers, dates, money, policy and promises against the DB and the rules. False → **FALSE-INFO**.
2. **Useful?** Does it say what happens next, why a control is disabled, what the deadline is? Missing → **MISSED-OPPORTUNITY** (13-d has the checklist per surface).
3. **Plain?** Padded, cheerful filler, robotic or generic ("Something went wrong", "Seamlessly", "Great news!", "Your journey awaits") → **COPY / AI-SLOP**.
4. **Raw?** Enums (`SUBSCRIPTION`, `APPROVED_PENDING_PAYMENT`), cuids, paise, ISO strings, IANA names where a person reads them, `[CODE]` brackets → **COPY** (P2).
5. **Consistent?** Same thing, same word, on every surface (UX-14). Plurals and units are 10's `TZ-49`; date and time formats are `TZ-47`.

Quote every finding verbatim with its route and the element.

## UX-01 — The surface inventory

**Steps:** visit every surface below at least once in this folder (any persona that can reach it). Tick it in your report.

| Area | Surfaces |
| --- | --- |
| Discovery and booking | expert page and booking dialog (the single-time picker for instant and review-first experts, "Show N taken times" and "Notify me", the mentorship dialog's start-date and trial steps), program pages, event pages (webinar, class), waitlist control |
| Checkout | `/checkout/plans/{consultation,subscription,webinar,class}/[planId]`, `/checkout/plans/trial/[trialId]`, `/checkout/pay/[paymentId]`, success pages, org payer selector |
| Consultant scheduling | allocate page (grid, tray, context chips, partial dialog, phone notice), Manage timings (grid, pattern scheduler, stop panel), Move to a new date dialog, Move upcoming sessions dialog, class session cancel and make-up dialogs, consultant reschedule page |
| Consultee scheduling | reschedule page (grid and phone day list), proposal card, free rebook page, return-a-session dialog |
| Cancelling | consultation cancel dialog, subscription cancel dialog, seat leave dialog, trial cancel dialog, expert cancel dialog, request withdraw, approval withdraw, decline |
| Settings | availability editor (weekly, custom), booking mode ("Review requests first"), account zone select and convert prompt, notification preferences |
| Plan editors | subscription, webinar (with the host's single-time picker), class (first session picker, late join, window) |
| Dashboards | consultant Home, Requests inbox (tabs, rows, batch approve bar), Appointments list and calendar, appointment detail (both sides), earnings, consultee Home, Payments and payment detail, org appointments, requests, my program, compensation |
| Back office | staff appointments, payment detail, refunds, stuck work, class-series doors, admin maintenance and system jobs |
| Messages | bell, emails (via `FailedEmail.htmlBody`), toasts |

**Expect:** every row visited, or marked BLOCKED with the reason.

**Probe further:** any booking surface you find that isn't listed: add it and sweep it.

## UX-02 — Expert page and booking dialog

**Steps:** as B2 (signed in) and signed out, open H1's page. Open the consultation dialog (instant), then with H1 in "Review requests first" (03-c) the request dialog, then the trial picker. Read every string. Pick a slot, unpick it, try a taken one.

**Expect:** the dialog names the plan, length, price, zone (zone line), what happens after the click (instant confirm vs request), and the cancellation policy or a link to it.

**Probe further:** "Request" vs "Book" wording when the expert is in request mode; does the dialog say the expert must approve and how long that may take (48 h)? Does the trial picker say whether the trial is free or ₹100 before the click?

## UX-03 — Checkout pages

**Steps:** open each checkout front door with a valid selection (no payment needed for reading). Read the header, details rows, totals, policy text, buttons, and any notice ("This expert currently has room for about N of S sessions a week…").

**Expect:** the details match the selection (TZ-35 owns the time row); totals in ₹ with tax lines; the cancellation policy stated once and true.

**Probe further:** the consultation checkout falls back to a title "One-on-One Session", a headline "Consultant" and a language "English" when data is missing. Do these fallbacks ever show for a real plan? "Consultation Details" in Title Case beside sentence-case rows. Record each fallback seen as **COPY** (P3), and a fallback that states something false (language) as **FALSE-INFO**.

## UX-04 — Allocate page, tray and toasts

**Steps:** as H1 on a G-SUB allocate page: hover, pick, overfill a week, pick across a busy block, open the partial dialog, try Auto on a full week, and read every toast title and description.

**Expect:** each toast names the rule and the fix. Known strings: "You can only schedule 3 sessions per week. This week is full — choose a different week."; "That's more sessions than this plan week has room for. Remove a time, or place it next week."; "A subscription is scheduled one plan week at a time. Pick times inside the open week shown on the calendar."

**Probe further:**

- "All sessions selected" / "You've selected all the required time slots. Click 'Allocate' to confirm." is a destructive (red) toast for a success, and the button is labelled **Save**. **COPY** (P2).
- "Slots must be consecutive" / "Each session requires back-to-back time slots on the same day. Select the immediately following slot." uses "slots"; the tray says "sessions" and "times". **COPY** (P3).
- "Each session requires 1 hours (2 consecutive slots)" (TZ-49).

## UX-05 — Reschedule pages, both sides

**Steps:** as B1 and as H1, open Reschedule on a booking ≥ 24 h away and one under 24 h away. Read headings, instructions, the "Any time works" option, the proposal card and the refusal for the near session.

**Expect:** the page says how many moves are left (2 per session for the consultee, 2 per booking for the expert), the 24-h rule, and what happens after submit (confirm now vs wait for the other party).

**Probe further:** the near session's refusal is `RESCHEDULE_WINDOW`: "Cannot reschedule within 24 hours of the meeting. The earliest meeting starts in N hours." "Cannot" is robotic and "meeting" is used nowhere else. The grid's tooltip says "This session starts within 24 hours and cannot be rescheduled." Report **COPY** (P3). Does the page offer the next step (cancel, message the other party)?

## UX-06 — Cancel and leave dialogs

**Steps:** open each cancel or leave dialog without confirming: consultation (≥ 24 h, 2–24 h, < 2 h), subscription mid-plan, webinar seat (outside and inside the window), class seat, trial (paid), expert cancel.

**Expect:** the dialog shows the refund in ₹ before the click, the tier and why, what the other party is told, and whether it can be undone.

**Probe further:** the writer report (04–06) found `CancellationPolicyNote` copy that contradicts the dialog's quote. Compare the note, the quote and `GET …/cancel/preview` for each dialog. Expert cancel: "<client> gets a full refund of ₹X. Cancelling a paid booking counts against your reliability." Is the word "reliability" explained anywhere (strikes, the 3-in-90-days notice)?

## UX-07 — Manage timings, pattern scheduler, re-time and series move

**Steps:** as H2 on an unsold class (pattern scheduler and grid), a sold class (stop panel, Move upcoming sessions), a sold webinar (stop panel, Move to a new date), a class session (cancel, make-up).

**Expect:** one name for each action across the menu, the panel, the dialog title, the toast, the API refusal and the bell.

**Probe further:** the stop panel and the `USE_RETIME` refusal sentences now name the real button ("Move to a new date" for a webinar, "Move upcoming sessions" for a class); only the toast title still says "use Re-time"; the editor refusal says "Use the reschedule workflow instead" (WE-32). The pattern scheduler says a busy co-host clashes "with your calendar". Collect them in UX-14.

## UX-08 — Availability editor

**Steps:** as H3 (weekly) and H4 (custom), add, edit and remove windows; trigger each editor error (overlap, too short, over 12 h, past date, empty set).

**Expect:** errors name the window by day and time, in the consultant's words.

**Probe further:** writer report bug 3: messages call a window a "Session" ("Session must be at least 30 minutes long", "Session cannot exceed 12 hours") and prefix lowercase day keys ("monday slot 2: …"). The server contract's messages read "Window 1: times must be whole minutes from 0 to 1439" (UX-73). "Times are in Asia/Kolkata and follow daylight saving automatically." for a zone without DST (writer report bug 9). Re-confirm and quote.

## UX-09 — Plan editors

**Steps:** as H1 (subscription), H2 (webinar, class), read every label, help text and validation message; save a draft and publish; trigger `PLAN_NOT_FEASIBLE` (SU-11).

**Expect:** help text says what the buyer will see; the feasibility refusal names the shortfall and the fixes.

**Probe further:** `PLAN_NOT_FEASIBLE`: "This plan can't be delivered from your published availability. <reason> Add hours, shorten the sessions or lower the sessions a week, or save it as a draft." Good shape; check the joined sentence reads cleanly. Subscription drafts save with `feasibilityWarnings` that no component shows (writer report open question 20): **MISSED-OPPORTUNITY**.

## UX-10 — Requests inbox

**Steps:** as H1 with a mix of rows (request, awaiting payment, next cycle, trial, declined): read tabs, chips, sort names, bucket titles and hints, row lines, batch-approve outcomes, every toast (approve, decline, remind, withdraw approval, keep original, withdraw proposal).

**Expect:** one verb per toast (`TOAST` in `labels.ts`): "Approved", "Approved — waiting for the learner to pay", "Declined", "Reminder sent", "Approval withdrawn", "Kept the original time", "Request withdrawn".

**Probe further:** "Remind sent · next in 3 h" vs "Reminder sent". "Showing the 20 most urgent of 34 — pick a filter to see the rest." Is "most urgent" true for the Money sort? `CHECKOUT_HOLD_LINE` "The learner is paying now — nothing to do. The time stays held until then." Until when?

## UX-11 — Dashboards: Home, Appointments, detail

**Steps:** as H1, B1 and DR, read Home greetings, Needs-you items, today and upcoming lists, empty states, Appointments rows and filters, both details.

**Expect:** labels from `BOOKING_LABEL`; Needs-you items from `action-items.ts` with a title, a body and one action.

**Probe further:** "Here's what's happening with your appointments today"; "Enjoy your free time or check upcoming sessions"; "Your schedule is clear for now" (DB-17). Writer report (04–06): a raw enum "covers SUBSCRIPTION" somewhere in the money lines. Find it and quote the route.

## UX-12 — Payments, refunds and earnings

**Steps:** as B1 (Payments list and detail with a refund), H1 (Earnings with a hold and a reversal), OS (org spend).

**Expect:** each amount says what it is (paid, refunded, pending refund, held until, released), in ₹.

**Probe further:** refund lines from `money-state.ts`: "Refund processed · bank arrival not confirmed", "Refunded (partial)", "Refund failed — our team will retry or contact you". Does the consultee see when to expect the money (the bell says 5–7 working days)? Earnings "hold": does H1 see why and until when?

## UX-13 — Back-office booking surfaces

**Steps:** as ST, read the appointment list, a payment detail, the refunds queue, stuck work, the class-series doors, the platform cancel form.

**Expect:** operators may see codes and enums next to labels, but every action says what it will do to the customer and their money before the click.

**Probe further:** reason fields labelled "Reason (kept in the audit log)" vs what the customer reads (DB-21). Does the platform cancel form show the refund amount first?

## UX-14 — One name per thing

**Steps:** while sweeping UX-02 to UX-13, fill this table with every word you see for each concept and where.

| Concept | Words seen (route) |
| --- | --- |
| A booked time | session / slot / meeting / appointment / booking |
| A published availability block | window / session / slot / hours |
| Moving a sold group event | Re-time / Move to a new date / Move upcoming sessions / reschedule |
| A plan's scheduling unit | plan week / week / cycle / month |
| Ending a booking | Cancel / Leave / Withdraw / Decline / Remove |
| The host | consultant / expert / host / instructor |
| The buyer | consultee / learner / client / attendee / participant |
| Paying later | pay link / payment link / payment due |

**Expect:** one word per concept on customer surfaces (operator surfaces may differ).

**Probe further:** report one **COPY** finding (P2) per concept with more than one customer-facing word, listing each route. Note where the same page uses two words for one thing (worst case).
