# 08-d · Money: earnings, holds and the org-hosted split

**Needs:** CO-12 (Wipro), CO-17 (LearnPro-hosted OX booking), MO-01, MO-03, MO-31, MO-32; local `next dev` for `[local]`. MQ-queries in [README.md](README.md).
**Personas:** H1, H2, H3, OX (LearnPro expert, payout SELF), OH (LearnPro owner), OS, AD, ST.
**Docs under test:** `lib/payments/payouts/{constants,earnings-hold,earnings-hold-ops}.ts`, `scripts/earnings/release-earnings.ts`, `docs/booking/` money pages.

Defaults read from code: platform fee 20 % (`PLATFORM_FEE_PERCENTAGE`; per payment `platformFeeBps`), hold after the anchor 24 h for consultations and classes, 48 h for webinars, 168 h for subscriptions; anchor = later of capture and the last live session's end; +7 days for a new expert (first paid earning < 30 days old or lifetime share < ₹50,000). LearnPro's rate card is platform 10 % / org 10 % / consultant 80 % (seed).

## MO-43 — LearnPro-hosted booking: three shares that add up `[local]`

**Why it matters:** an org-hosted sale pays the platform, the org and the expert; a wrong split pays someone else's money.

**Setup:** CO-17's booking (B1 books OX's F-PL3 consultation).

**Steps:** R-04, MQ-1, MQ-3 for the payment. As OH open `/dashboard/organization/[LearnPro]/compensation` and `…/home`; as OX open Earnings.

**Expect:**

- `Payment.hostOrganizationId` = LearnPro.
- `OrganizationEarnings`: one row; `platformBpsApplied = 1000`, `orgBpsApplied = 1000`, `consultantBpsApplied = 8000` (or the rate card in force; record `rateCardIdApplied`); `platformFeePaise + orgSharePaise + consultantSharePaise = grossAmountPaise`.
- OX is payout `SELF`: record whether OX also has a `ConsultantEarnings` row for the 80 % and that the expert share is not counted twice (org row + consultant row must not both pay OX).
- `holdUntil` = session end + 24 h on both rows.

**Cross-check:** OH sees LearnPro's 10 %; OX sees their 80 %; neither sees the other's private split unless the page says why. Times in IST.

**Probe further:** does OX's Earnings say "via LearnPro Academy"? Does OH's compensation page explain the rate card, and is any figure shown as raw bps?

## MO-44 — Refunding the org-hosted booking reverses each share in proportion `[local]`

**Why it matters:** a refund that claws back only the expert leaves the org holding refunded money.

**Setup:** MO-43's booking. Cancel at 2–24 h notice (owner-approved shift) for a 50 % refund.

**Steps:** cancel as B1; MQ-3 again.

**Expect:** `OrganizationEarnings.refundedAmountPaise` = 50 % of the org row's gross share split (record exactly how the 50 % divides across platform, org and expert); `ConsultantEarnings.refundedShareAmount` moved by the expert's half; nothing pays out more than the remaining net.

**Cross-check:** OH's compensation and OX's Earnings both show the partial reversal.

**Probe further:** is there a line telling OH why their figure dropped (booking, date, refund)?

## MO-45 — An org-funded (Wipro) booking pays the expert like a card booking `[local]`

**Why it matters:** the expert shouldn't earn less because a sponsor paid.

**Setup:** CO-12's booking before CO-78 cancels it (or a fresh one: B4, H1 S-08, Wipro rail).

**Steps:** MQ-1 and R-04 earnings.

**Expect:** `ConsultantEarnings` exists with the same fee basis as MO-01 (record `platformFeeBps`); `holdUntil` rule the same. Record whether Wipro's licence price differs from the list price and which one `grossAmount` uses.

**Probe further:** H1's Earnings: is the booking labelled as sponsored? Is that useful to the expert or noise?

## MO-46 — A rescheduled session moves its earnings release `[local]`

**Why it matters:** a release anchored on the old time pays the expert before a later session happens.

**Setup:** MO-01's booking (Wed D+2). Record `holdUntil`.

**Steps:** B1 reschedules it to a later day with a free time (CO-46 path, auto-confirm). Read `holdUntil` again. Then H1 reschedules it earlier (CO-60, B1 accepts). Read again.

**Expect:** `holdUntil` = new session end + 24 h after each move (the allocator and `replaceOccurrence` recompute it). An unchanged `holdUntil` after a move is a BUG P1 (money released before delivery).

**Probe further:** H1's Earnings "next release" date follows the move?

## MO-47 — A new expert's earnings wait an extra week

**Why it matters:** the new-expert hold is fraud control; it must apply once and stop after tenure.

**Setup:** pick the persona with no `SUCCEEDED` earnings yet (check `SELECT count(*) FROM "ConsultantEarnings" e JOIN "Payment" p ON p.id = e."paymentId" WHERE e."consultantProfileId" = :cid AND p."paymentStatus" = 'SUCCEEDED'` for H3 and H4). If both have history older than 30 days and lifetime share ≥ ₹50,000, BLOCKED (can't make a new expert without new accounts).

**Steps:** `[local]` book that expert once; R-04 earnings.

**Expect:** `holdUntil` = anchor + type hours + 7 days. Compare with H1's MO-01 row (no extra week if H1 isn't new).

**Probe further:** does the new expert's Earnings page say why the first payouts take longer? If not, MISSED-OPPORTUNITY.

## MO-48 — Trial earnings and their hold `[local]`

**Why it matters:** reading the code, a trial's earning is created with `holdUntil = null`; that must not mean "payable before the trial happens".

**Setup:** TR-06's paid trial (needs a gateway; else BLOCKED) or any captured paid trial.

**Steps:** R-04 earnings for the trial payment; note `status` and `holdUntil`. If `holdUntil` is null and `status` is `PENDING`, check whether `release-earnings` would select it (its claim needs `holdUntil <= now`): record what moves a trial earning to `READY` (completion, conversion, something else).

**Expect:** the earning stays unpaid until the trial is delivered. A trial earning `READY` before the trial's end is BUG P1.

**Probe further:** an expert-cancelled paid trial (TR-29): the earning becomes `REFUNDED` and never reaches a payout.

## MO-49 — Earnings stay held while money is still moving

**Why it matters:** the release must wait for refunds in flight, refunds owed and undelivered sessions.

**Setup:** three H1 earnings, each past `holdUntil` by owner-approved SQL (`UPDATE "ConsultantEarnings" SET "holdUntil" = now() - interval '1 hour'`):

- A: payment with a `PENDING` refund (MO-61 shape, or an owner-approved status write on a QA mock refund);
- B: payment with `refundOwedKey` set (MO-58 emulation);
- C: a booking whose session is still in the future (shift `holdUntil` only).

**Steps:** NEEDS-OWNER-RUN `release-earnings` (SW-29).

**Expect:** none of A, B, C moves to `READY` (`RELEASABLE_PAYMENT` excludes PENDING refunds, a set `refundOwedKey` and undelivered occurrences). A plain past-hold earning in the same run does move. Restore the shifted values at cleanup.

**Probe further:** H1's Earnings for A, B, C: does each say why it's still held?

## MO-50 — An operator hold freezes an earning and shows its reason

**Why it matters:** ops hold money during a complaint; the expert must see that it's held and why, and the release must be refused while a refund is open.

**Setup:** an H1 earning in `PENDING` or `READY` (QA booking). AD signed in.

**Steps:** in the back office find the earning (Money → Earnings, or the payment page) and place a hold if a door is offered; record the door and copy. Then try **Release hold** with a `PENDING` refund on the same payment (owner-approved status write, as MO-49 A), then without.

**Expect:** an `EarningsHold` row `reason = OPERATOR`, `releasedAt` null; earning `status = HELD` with `preHoldStatus` kept. Release with an open refund: refused with human copy. Release without: `releasedAt` set, status back to `preHoldStatus`. If no hold door exists in the UI, record that (holds are also placed by disputes, moderation, overages and support cases).

**Cross-check:** H1's Earnings shows the held amount with a reason; record the words.

**Probe further:** a `DISPUTE` or `OVERAGE` hold can't be released by the operator door (`OPERATOR_RELEASABLE` is OPERATOR and MODERATION only); if any such hold exists on a QA payment, try and record.

## MO-51 — Co-host earnings on a webinar split by share `[local]`

**Why it matters:** collaborator splits must add to the expert share, never to more.

**Setup:** an H2 webinar with H3 as co-host (05's co-host case), one paid seat.

**Steps:** R-04 earnings (`role`, `shareBps` per row).

**Expect:** one `OWNER` row for H2 and one `COLLABORATOR` row for H3; `shareBps` sum to 10,000 of the expert share; each row's `consultantSharePaise` matches its bps; platform fee taken once. A refund (seat leave) reverses both rows in proportion.

**Cross-check:** H3's Earnings lists the webinar as co-host income.

**Probe further:** if the co-host is removed after the sale, what happens to their row?

## MO-52 — The consultee and expert see the same refund, in their own words

**Why it matters:** both parties talk to support about the same money.

**Steps:** for MO-44 (org-hosted partial refund) and MO-31 (full), put side by side: B1's Payments row and detail, B1's bell and email subject; OX/H1 Earnings Activity row; staff payment page.

**Expect:** the same refund amount and date (each in its viewer's zone); the expert side shows the share reversed, not the buyer's full refund as the expert's loss.

**Probe further:** quote both sides verbatim. Is "refund" used for the buyer and "reversal/clawback" for the expert consistently?

## MO-53 — Earnings for a free booking and a credits booking

**Why it matters:** free should earn nothing; credits are platform money and should still pay the expert.

**Setup:** CO-07 (free) and MO-08 step 2 (credits).

**Steps:** R-04 earnings for both.

**Expect:** free: no `ConsultantEarnings` or a ₹0 row (record); credits: an earning on the full price with the normal fee. If credits pay the expert nothing, report it as an open question for the owner, not a bug.

**Probe further:** H1's Earnings shows ₹0 rows as noise?

## MO-54 — Earnings totals after this folder's refunds

**Why it matters:** the regression smoke in the PR prompt: "Earnings page totals after refunds".

**Steps:** after all 08 cases, re-run MO-39's SQL for H1, H2 and OX and reload each Earnings page.

**Expect:** every page figure equals the SQL; no negative bucket; refunded rows don't count as payable.

**Probe further:** compare the Analytics tab's charts with the Summary numbers for the same period.
