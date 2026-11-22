# Go-live priorities, 22 Nov 2026

**What this is:** the shortest route to a B2C launch with real money. I read the 59 open `launch: pre-mvp` issues, the 30 Oct launch audit (#2459, 68 items), the finance umbrella (#2230), today's mock-payment QA round (#2967), the open PRs, the `go-live` skill and checklist, and the code at `dev` @ `e605202`. I checked the claims I relied on most against the code. Each one is marked **(verified)** or **(from issue)**.

**Bottom line:** the core works. Over 15 genuine test-mode bookings of consultations, webinars and classes confirmed. Ledger, refund, cancel-tier and webhook-dedupe invariants held in today's QA round. Several big audit blockers have shipped: the Better Auth id/`cuid` capture bug, the tenant credit and invoice lockdown, the RazorpayX egress-proxy plumbing, and the public roster and revenue-share exposure. Four groups of work are left:

1. **About 5 money bugs on the capture and refund path.** Three already have open PRs.
2. **Company, legal and tax steps only the owner can do.** These take the longest, so start them today.
3. **About 8 environment and config steps** from the go-live runbook.
4. **One real end-to-end pass of the five B2C journeys,** then two live ₹1 tests.

Everything else can wait until after launch if you accept the scope cuts in §1.

---

## 1. Scope cuts that buy the most time

Take these decisions first. Each one removes a whole group of work.

| Decision                                                                                                                                                 | What it removes from the launch list                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **B2C only.** Keep `ENABLE_HOST_ORGS` off and sell no org-funded, wallet, invoice or licence products.                                                   | B2B-01..04, #2126, #863, the org half of #2971, the org rows of #2440, enterprise TDS and dunning                                     |
| **Launch without GST registration** (`PLATFORM_GSTIN` unset), as the docs already plan.                                                                  | #2042 until the ₹15 lakh digest alarm fires; IRP, invoice and credit-note jobs                                                        |
| **Take money first, switch payouts on before the first weekly batch is due** (hold period plus the Monday batch, so about 1–2 weeks).                    | CA answer (#2231), TAN, egress proxy purchase (#2748) and the payout canary move out of launch day. They get a hard deadline instead. |
| **Launch consultations, webinars and classes.** Add subscriptions and paid trials only after PR #2969 lands and one test-mode purchase of each confirms. | Otherwise hide those two at launch                                                                                                    |
| **Single-host events only. No revenue-share collaborators.**                                                                                             | #2823 (CA and counsel sign-off on multi-party splits) and most of #2827                                                               |
| **Hide replay sales and digital products** unless #2975 parts 1–3 land.                                                                                  | The notes-routing risk on those rails                                                                                                 |
| **Keep one shared database for now** (owner decision on #1873), with a rule: no seeds, QA scripts or manual job runs against production after launch.    | #1873 and OPS-01 until 2–4 weeks after launch                                                                                         |

---

## 2. Must fix in code before real money (P0/P1)

In order. Small means under a day, Medium means 1–3 days.

| #   | Item                                                                                                                                                                     | Why it blocks                                                                                                                                                                                                          | State                                                                                                                                                                                   | Size                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | **#2962: subscriptions and paid trials are charged but parked** as `REQUIRES_MANUAL_RECOVERY`                                                                            | Every gateway-paid subscription takes the money and never confirms. Seen on real test-mode traffic (₹5,994).                                                                                                           | **PR #2969 open**                                                                                                                                                                       | Small. Merge it, then make one test-mode subscription and one trial purchase on a preview                                 |
| 2   | **#2974: a gateway auto-refund of another payment attempt is booked as a full refund of the booking**                                                                    | A UPI timeout followed by a retry is common in India. The ledger then says the money went back when it did not, the expert is unpaid, and nothing alerts.                                                              | **(verified)** `handleRefundCreated` matches `paymentIntent` OR `gatewayPaymentId` and never checks `captured` or that the payment id matches (`app/api/webhooks/utils.ts`). No PR yet. | Small. Use the guard proposed in the issue, plus 3 pin tests                                                              |
| 3   | **#2963: a parked capture is invisible to ops**                                                                                                                          | Ops cannot see captured money that has no booking                                                                                                                                                                      | **Draft PR #2973**                                                                                                                                                                      | Small                                                                                                                     |
| 4   | **#2975 parts 1–3: the capture router trusts the payment's `notes`**                                                                                                     | Top-ups, replay and product sales misroute if the notes arrive empty. **(verified)** the bug in `app/api/checkout/verify/route.ts`: `captured?.notes ?? rzpOrder.notes` never falls back, because `{}` is not nullish. | No PR                                                                                                                                                                                   | Small for the 3-line fallbacks. Leave the order-registry redesign until after launch.                                     |
| 5   | **Checkout timeout answers a bare 500** (#2967 / #2720 MO-F5)                                                                                                            | The buyer sees a generic error and every timeout uses up Sentry quota                                                                                                                                                  | **Draft PR #2977**                                                                                                                                                                      | Small                                                                                                                     |
| 6   | **#2970: after-payment screens state things that are not true** (a paid trial still asks for payment, wrong renewal date, earnings disagree)                             | Buyer and expert trust on day one. Only the paid-trial and earnings parts matter if subscriptions ship.                                                                                                                | No PR                                                                                                                                                                                   | Medium                                                                                                                    |
| 7   | PR #2984 (paying an existing order waits for the booking) and PR #2986 (reschedule earnings-hold release)                                                                | Already written                                                                                                                                                                                                        | Open PRs                                                                                                                                                                                | Review and merge                                                                                                          |
| 8   | **#2723: P1 leftovers from the 12 Nov bug hunt** (7 P1, for example BK-1: a 1:1 request is priced at approval from the current plan price and the pay link is re-minted) | Charging the wrong amount                                                                                                                                                                                              | Third pass not yet fixed                                                                                                                                                                | Medium. Fix only the P1s that hit B2C rails.                                                                              |
| 9   | **#1084 / SEC-06: dependency advisories**                                                                                                                                | **(verified)** `npm audit --omit=dev`: 1 high (`zod <4.6.6`, and the repo is on 3.25), 8 moderate, 1 low                                                                                                               | —                                                                                                                                                                                       | Small. Check whether the zod advisory is reachable. If not, record that and accept it; a zod 4 move is not a launch item. |
| 10  | **#2064: legacy `getSession()` callers**                                                                                                                                 | A failed session lookup should answer 503, not log the user out                                                                                                                                                        | Mostly done; only a couple of call sites look left                                                                                                                                      | Small                                                                                                                     |

Already fixed, so don't redo them: FIN-01 (`userId` cuid), FIN-03/04 (tenant credit and invoice lockdown), the egress proxy code (`RAZORPAYX_EGRESS_PROXY_URL` is read), SEC-01/02 (public plan routes no longer select `participants.userId` or `revenueShareBps`), and SEC-03 on the leads route (`requireBackofficeSurface`). **(verified, spot checks)**

---

## 3. Company, legal and tax steps (owner only, long lead time, start today)

These come before Razorpay live keys can exist. None of them is code.

1. **Company PAN, a current account in the company's name, the capital deposit, INC-20A filed.** Razorpay activation depends on these.
2. **Razorpay activation as a registered company.** It reviews the live Terms, Privacy and Refund pages. An earlier individual application was rejected, so do not reuse it.
3. **Grievance Officer: name and phone** in `lib/company.ts` (#2288). **(verified)** both are empty strings today. The skill calls this optional, but the Consumer Protection (E-Commerce) Rules 2020 already require a named grievance officer with contact details. Treat it as required for launch. The code change is two lines.
4. **Expert badge wording** ("Verified by Familiarise" versus the interview copy): confirm with the lawyer or reword it.
5. **CA written answer on 194-O vs 194J** (#2231). It gates **payouts only**, so it must arrive before the first payout batch, not before launch.
6. **TAN, then pin `TDS_ENGINE` and `ENABLE_TDS_194O_GROSS`.** Same deadline as item 5.
7. **Buy the static-egress proxy and allowlist its IPs in RazorpayX** (#2748). Same deadline. Also ask Razorpay whether RazorpayX can share the current account and whether it needs a GSTIN.
8. **Vendor accounts under a company admin address, with a second owner** (#2438). One afternoon, and it removes a single point of failure.

Can wait until after launch: the dark-pattern certificate (#2666, due 31 Dec 2026), terms versioning and re-acceptance (#1882), and the DPDP residue (#2468). DPDP ss.3–17 and its penalties commence **13 May 2027**, according to the repo's own compliance docs.

---

## 4. Environment and config (the go-live runbook, in order)

Full steps: `.claude/skills/go-live/SKILL.md` and `docs/finance/70-operations/07-go-live-checklist.md`.

1. **Split the Stream app** (#2364 / MEDIA-01, draft PR #2376). Production Stream is shared with dev and previews today. Create Familiarise-dev, move the preview and local keys to it, merge #2376, and clear mock users and channels from the production app. **This must happen before real users arrive.**
2. **Resume the job fleet.** Delete `ops:active_cron_platform` or set it to `netlify`, then unpause the heartbeats and the Sentry monitor. Refunds owed, reminders, expiry and the closed-order reconciler all depend on it. First run the owner-run jobs listed in #2967 once on the mock data and check the expected outcomes.
3. **Rotate exposed secrets** (rotation runbook §3.1). `CRON_SECRET` lives in 3 places.
4. **Money settings:** approve a `PlatformFeeSchedule` (otherwise both rails fall back to 20%), set `ReferralProgramConfig.monthlyBudgetPaise` (0 keeps referrals off), deactivate the seed discount codes, run the below-floor price query, and set the payout constants in `lib/payments/payouts/constants.ts`.
5. **Get the ops digest reading clean** (only the expected GST skips), then set **`EMAIL_DELIVERY_MODE=live`** after the Resend domain and webhook checks.
6. **Purge sandbox identities once**: 46 payout accounts, 1 org payout account and 42 test payments, per #2092.
7. **Live keys, then two live ₹1 tests** (a checkout and a full refund). Delete `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION` in the same change.
8. **Unpause the 8 Better Stack telemetry alerts** after the reset, once the money gauges read 0.
9. **CI** (#2752, #1530 / OPS-02): GitHub Actions has a $10 cap with "prevent further usage". PR CI was burning about $3 a day, and hitting the cap blocks `Release checks`. Turn off PR CI into `dev`, keep `Release checks` required on `prod`, and raise the cap a little. **(verified)** `ci.yaml` still decodes the production `ENV_FILE` into `.env` on same-repo PR jobs. Remove that, or at least keep it off PR triggers.
10. **Schema** (#2700, draft PR #2721): the database still holds only mock data, so a Prisma-migrations baseline costs least now. If #2721 cannot land within the week, freeze the schema, launch on `db push`, and cut over in the first month. Also confirm the 3 uniques from the sidecar-timeout trap exist.

---

## 5. Verification pass (one round, before live keys)

On a deploy preview with test keys, run the five B2C journeys end to end **in a browser**. Today's QA round had no browser, so every UI leg is still open:

discovery → sign-up and onboarding → request or checkout → capture → schedule and join (Stream) → completion → receipt and earnings

Also run a cancel with refund, a support case, and one data export or erasure. Include **one real test-mode subscription purchase and one paid-trial purchase**, which also verifies #2962, and one refund made from the Razorpay dashboard (#2965's premise). Then run the two live ₹1 tests from §4.7.

A full 2x-peak load gate (#874) and the cold-start bar (#1124) are not needed at launch traffic. A 10-concurrent checkout smoke test on the same slot is enough.

---

## 6. The 27 subsystems at a glance

I found no canonical list of 27 subsystems in the repo or the issues, so this is my grouping of the docs, skills and labels. Status values:

- **Ready:** launchable as is.
- **Fix:** has an item in §2.
- **Owner:** needs a step from §3 or §4.
- **Cut:** off at launch, per §1.

| #   | Subsystem                                        | Status                     | Launch work                                                                     | Skip for now                                                                            |
| --- | ------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Auth and sessions (Better Auth)                  | Fix (small)                | #2064 residue; check that the Turnstile production keys are set (SEC-07, #2065) | #1934, #2222, SSO                                                                       |
| 2   | Back office and authorization                    | Ready (spot-checked)       | SEC-03 re-check on other admin routes                                           | #2440 history paging and exports                                                        |
| 3   | Onboarding and expert verification               | Ready                      | Verification docs over 4 MB use signed URLs (MEDIA-03): confirm in the QA pass  | Progressive trust (#2078)                                                               |
| 4   | Discovery, Explore and SEO                       | Ready                      | —                                                                               | Old UI PRs (#1750, #1786, #1797, #1888, #1903, #1909), dynamic sitemap                  |
| 5   | Plans and pricing                                | Owner                      | Fee schedule, price floor query, seed codes                                     | #2734 InPaise rename                                                                    |
| 6   | Booking and scheduling                           | Fix                        | #2723 B2C P1s; merge #2984 and #2986                                            | #2720 trains 1–5 except the 503 fix, #2740 decisions                                    |
| 7   | Trials and subscriptions                         | Fix or Cut                 | #2969 plus one purchase each; #2970                                             | Renewal UX                                                                              |
| 8   | Checkout and capture                             | Fix                        | #2962, #2975 (1–3), #2977, #2963                                                | Order registry redesign                                                                 |
| 9   | Refunds, cancellations and disputes              | Fix                        | #2974                                                                           | #2965 decision, #2170 discovery residue (the reconciler already re-reads closed orders) |
| 10  | Ledger and reconciliation                        | Ready                      | Imbalance query after the ₹1 tests                                              | Settlement recon (FIN-07)                                                               |
| 11  | Earnings, payouts and TDS                        | Owner (by the first batch) | CA answer, TAN, egress proxy, canary payout                                     | Org payouts                                                                             |
| 12  | GST and tax documents                            | Cut (unregistered)         | Watch the ₹15 lakh alarm; #2971 turnover undercount before then                 | #2161, IRP                                                                              |
| 13  | Enterprise and B2B                               | Cut                        | —                                                                               | #2126, #863, B2B-01..04                                                                 |
| 14  | Collaborators                                    | Cut (single host)          | —                                                                               | #2827, #2823                                                                            |
| 15  | Stream chat and video                            | Owner                      | Split the Stream app (#2376); production call in the QA pass (MEDIA-04)         | #2725 decisions, #2768, PR #2961                                                        |
| 16  | Recordings, replays and digital products         | Cut or Fix                 | Hide sales, or fix #2975                                                        | Replay marketplace                                                                      |
| 17  | Documents and storage                            | Ready                      | —                                                                               | #2404, #2284                                                                            |
| 18  | Notifications (Novu)                             | Ready                      | Test booking proves bell and email (checklist 4.1)                              | COMMS-02 timing per recipient, #2029                                                    |
| 19  | Email (Resend)                                   | Owner                      | `EMAIL_DELIVERY_MODE=live`, domain and webhook check                            | —                                                                                       |
| 20  | Support and grievance                            | Owner                      | Officer name and phone; #2410 support DDL and Stream operator roles             | #2270 roadmap                                                                           |
| 21  | Compliance (DPDP, consent, erasure, legal pages) | Owner                      | Legal pages live for Razorpay; one erasure check                                | #2468, #1882, #2666 (Dec 31)                                                            |
| 22  | Reviews and feedback                             | Ready                      | —                                                                               | UX-05                                                                                   |
| 23  | Growth (newsletter, waitlist, referrals)         | Ready                      | Referral budget 0 or approved                                                   | —                                                                                       |
| 24  | Dashboard and copy                               | Fix (light)                | #2970; the 19 P1 strings in #2687; #2674 ₹0 and 429 copy                        | #2732 UI brief, P2/P3 copy                                                              |
| 25  | Scheduled jobs fleet                             | Owner                      | Resume, owner-run jobs from #2967                                               | #2402 fail-open proof, #2157 P2/P3                                                      |
| 26  | Observability and alerting                       | Owner                      | Unpause monitors and the 8 alerts                                               | #2156 checkout probe and stats token                                                    |
| 27  | Hosting, CI, database and security               | Owner                      | #2752 CI budget, #1530 `ENV_FILE`, secret rotation, #2700 decision              | #2751 region, #2405 restore drill, #2487, #2168, #1873 (first month)                    |

---

## 7. Suggested order of work

1. **Day 0:** start the owner steps in §3, items 1–3 and 7. Take the scope decisions in §1.
2. **Days 1–3:** merge #2969, #2973, #2977, #2984 and #2986. Write and merge fixes for #2974 and #2975 (1–3). Split the Stream app. Fix CI and the budget.
3. **Days 3–5:** #2970, the B2C P1s from #2723, the zod advisory check, the P1 copy strings. Settle the #2721 baseline or freeze the schema.
4. **Days 5–7:** browser QA of the five journeys on a preview (§5). Resume the fleet. Money settings. Secret rotation.
5. **Launch day (once Razorpay is live):** sandbox purge, live keys, two ₹1 tests, email live, alerts unpaused.
6. **Before the first payout batch:** CA answer, TAN, TDS pins, egress proxy, ₹1 canary payout, `ENABLE_LIVE_PAYOUTS=true`.
7. **Weeks 2–4:** second Supabase project for previews and dev (#1873), the order registry (#2975 design), then B2B and collaborators behind their own gates.

The calendar is set by the owner, company and Razorpay steps, not by the code.
