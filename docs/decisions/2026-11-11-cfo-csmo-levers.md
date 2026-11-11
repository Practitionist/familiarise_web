# ADR: CFO and CSMO levers — where each lever lives, and what the repository must do about it

- **Status**: Accepted (owner decisions, 2026-11-11). Items marked **(planned)** are not built; each is a later pull request that flips its own line. Items marked **(no code)** are recorded positions or owner purchases.
- **Date**: 2026-11-11
- **Author**: Platform engineering
- **Related**: [Tax compliance and pricing levers](2026-11-09-tax-compliance-and-pricing-levers.md), [Growth — waitlist, newsletter and referrals](2026-11-08-growth-waitlist-newsletter-referrals.md), [The repository and Notion split](2026-11-09-repo-notion-split.md), [Notion workspace consolidation](2026-11-11-notion-workspace-consolidation.md), [How payouts work](../finance/40-payouts/01-how-payouts-work.md), [Money go-live checklist](../finance/70-operations/07-go-live-checklist.md), [the go-live skill](../../.claude/skills/go-live/SKILL.md)

## Context

On 2026-11-11 the owner reviewed the platform through two lenses: a chief financial officer (fees, prices, payouts, vendor spend, runway) and a chief sales and marketing officer (referrals, trust copy, the sales motion). The review ended in a set of lever decisions. This record keeps only the mechanisms: which lever lives in which home, which repository field or constant carries it, and what the repository must do about it.

No lever value is written here. Every value is kept in Notion in two databases:

- value kept in Notion (Familiarise / Finance and Pricing / Finance Lever Register), the home of the finance levers;
- value kept in Notion (Familiarise / Growth & Marketing / Growth & Marketing Lever Register), the home of the growth levers.

The reasoning sits on the section pages around them (Pricing Strategy, Unit Economics & Financial Model, Vendors & Spend, Sales Playbook).

## Decisions

### 1. Two lever registers are the only home of tunable values

Both registers are databases in Notion. A row holds the approved value, its bounds, the alternatives considered, a revisit trigger, who decides, and the repository mechanism by name. A page that quotes a number must match its row, and a repository document never quotes the approved value (`documentation` skill, section 6). When a value changes, the owner changes the row first, then the admin configuration or the code that carries it.

### 2. Each lever class has one home

| Lever class                                          | Home                                | Carried by                                                                                                                                                                         | Enforcer                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The two platform fee rates                           | Admin configuration                 | `PlatformFeeSchedule` (`marketplaceBps`, `ownLinkBps`), maker and checker                                                                                                          | The approve route refuses a self-approval (`app/api/admin/fee-schedules/[scheduleId]/approve/route.ts`)                      |
| Referral budget, credit, discount, holds and waivers | Admin configuration                 | `ReferralProgramConfig` (for example `monthlyBudgetPaise`, `referrerRewardPaise`, `discountBps`, `holdSameIpReferrals`, `expertWaiverSessions`)                                    | `PATCH /api/admin/referrals/config` with a reason, under the shared profitability floor `platformFundedCapPaise`             |
| Platform discount codes                              | Admin data                          | `DiscountCode.isActive`; the seed codes are deactivated, never deleted, because seed payments point at them                                                                        | The Supabase SQL gate asks the owner to approve the statement                                                                |
| Hold, new-expert rule and minimum payout             | Code constants                      | `PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION`, `NEW_EXPERT_EXTRA_HOLD_DAYS`, `NEW_EXPERT_LIFETIME_SHARE_PAISE`, `MINIMUM_PAYOUT_AMOUNT` in `lib/payments/payouts/constants.ts` | A reviewed code pull request; `computeHoldUntil` and `withNewExpertHold` (`lib/payments/payouts/earnings-hold.ts`) read them |
| Per-format minimum and default prices                | Code constants                      | `lib/payments/pricing/price-bounds.ts`                                                                                                                                             | `assertPlanPriceWithinBounds` in the consultation and subscription plan create and edit routes                               |
| Founding-expert fee waiver                           | Admin data **(planned)**            | A new reason on `ConsultantFeeWaiver`                                                                                                                                              | To be granted through the admin waiver route, with count, expiry and cap taken from configuration                            |
| Vendor plans and their purchase triggers             | Notion                              | The Vendors & Spend page and the Finance Lever Register                                                                                                                            | The owner buys; nothing in code                                                                                              |
| Company, tax and registration steps                  | Law and the accountant, then Notion | The Tax, Legal & Regulatory Register                                                                                                                                               | The owner and the advisers                                                                                                   |

Fee and referral values are admin configuration because they change often and need no deploy. Payout holds are code because a wrong hold releases money early, so a change should pass review and tests. Prices are the single exception to "values live in Notion": the owner chose to enforce a floor in code, so the constants file will be the home of those values and the Notion row will name the file and keep the reasoning.

### 3. Per-format price bounds in code

The owner decided that minimum prices are enforced, not advised. `lib/payments/pricing/price-bounds.ts` holds, per format and per session length, a minimum price and a default (suggested) price, and it holds no maximum: an expert may price above the default. It also holds the pack rule for short packs (≤ 4 weeks, `PACK_MAX_WEEKS`), that the per-session price of a pack never falls below the single-session minimum less the largest allowed pack discount. A month-based plan or one longer than four weeks is a subscription and stays unfloored until subscriptions launch. The floor is enforced where a 1:1 or subscription plan is created or edited (`assertPlanPriceWithinBounds` in the plan routes under `app/api/plans/`). Checkout prices a 1:1 or a pack only from the saved plan price, so it needs no second guard. Formats not yet launched stay as guidance until each one ships. The existing trial floor, `PlatformPricingConfig.minTrialPriceInPaise`, is unchanged and stays at its default, so free trials remain possible.

### 4. A founding-expert waiver reason **(planned)**

`ConsultantFeeWaiver` today requires a `referralId`, and its reason enum holds only `REFERRED_EXPERT` and `REFERRING_EXPERT`, so a waiver cannot be granted without a referral. The planned change adds a founding-expert reason, makes the referral optional for that reason, and adds an admin grant route whose session count, expiry and cap on the number of founding experts come from configuration, not from constants. It is a schema change, so it follows the schema freeze and cutover plan (sidecars, owner-run `db push`). Until then a founding perk is applied by hand outside the system.

### 5. Vendor purchases follow triggers, not dates

Resend Pro, Supabase Pro, Sentry Team, the Better Stack responder seat and Telemetry Nano, and the GitHub Team seats are bought when a measurable trigger fires. The triggers themselves are owner-set plans and live in Notion, not here. One constraint is technical rather than a lever: the database moves to a plan with backups before the first real customer data is stored. Each trigger is a row in the Finance Lever Register and is explained on Vendors & Spend. GitHub Team seats equal the number of active contributors. This supersedes the "buy at go-live" lines of the earlier records, which now carry a pointer here.

### 6. The static-egress vendor is open

Live RazorpayX accepts calls only from allowlisted addresses, and Netlify has none that are fixed. The repository is vendor-agnostic: `RAZORPAYX_EGRESS_PROXY_URL` is the only coupling, read by `lib/payments/payouts/razorpay-payouts.ts`, and a live key without it refuses every payout call (`RAZORPAYX_EGRESS_NOT_CONFIGURED`). QuotaGuard Static or any other fixed-IP proxy satisfies it. The purchase is due before the first live payout at the latest.

### 7. The 48-hour scope promise needs a hold that covers it

The public trust promise is a scope claim that a buyer can raise within 48 hours of a session. The earning for a consultation must not become payable inside that window, or the platform would pay out money it may owe back. So `PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION` must be at least as long as the claim window. The constant now covers the window; the promise itself is public copy, and nothing in code yet makes a claim countable **(planned)**: a typed refund reason is a later pull request, and claims are handled by hand in the pilot.

### 8. Weekly payouts, and no fast-payout claim

`create-payout-batch` (`lib/cron/cleanup-registry.ts`) mints the consultant and organisation batch once a week, in the Monday window. The platform makes no fast-payout promise in copy, because a promise it cannot keep would be a trust claim of its own. A twice-weekly cadence is a later change in `lib/payments/payouts/scheduled-runs.ts` on a trigger in the register.

### 9. Company prerequisites come before go-live

The live Razorpay account cannot be activated until the company is ready. The prerequisites, which the go-live skill and the money checklist now list before their first step, are: the company PAN; a current account in the company's name with the capital deposit made; the INC-20A filing; Razorpay activation as a registered company with the legal pages live, because activation reviews the public site; and the RazorpayX bank and GSTIN question. Dates, amounts and names are kept in Notion (Familiarise / Tax & CA Working Notes / Tax, Legal & Regulatory Register). **(no code)**

### 10. Traffic-light checkpoints are a planning mechanism

The monthly dashboard on Unit Economics & Financial Model gives each metric a green, amber or red band, and a red band is a prompt to revisit the matching lever. The bands are warnings for the owner, not code: nothing in the repository reads them, and no job pages on them. The values are kept in Notion (Familiarise / Finance and Pricing / Unit Economics & Financial Model). **(no code)**

## Alternatives considered

- **Hold every lever value in the repository.** Rejected: a competitor learns the economics from the repository, and the owner could not change a value without a deploy (the repository-and-Notion split).
- **Hold every lever value in Notion only, including prices.** Rejected for prices: an advisory minimum is not enforceable, and the owner chose a hard floor.
- **Make payout holds an admin setting.** Rejected: a wrong hold releases money early and a setting needs no review, so the constants stay in code.
- **Buy every vendor plan at go-live.** Rejected: the cost lands before there is revenue or load to justify it; a measurable trigger buys the same protection later.
- **Name one static-egress vendor in code.** Rejected: the only coupling needed is a URL, and a vendor choice would bind a purchase decision the owner has not made.
- **Weekly payout with a fast-payout claim.** Rejected: the cadence is weekly, and copy must not promise more.

## Consequences

- Repository documents for pricing, referrals and billing guardrails point to the two registers and to Vendors & Spend instead of quoting values; the earlier records carry dated notes that point here.
- The go-live skill and checklist gain a company-prerequisites block, a payout-constants step and a planned price-bounds step, and the responder-seat and static-egress steps become trigger-based.
- Until the founding-expert reason ships, the owner applies it by hand in the pilot, and the pilot is bounded by that.
- Public copy must match what is true: the pricing page, the refund page and the trust wording in `app/(pages)/constants.ts` are aligned in a separate code pull request **(planned)**.

## Revisit triggers

- A format's guidance price becomes a floor when that format launches.
- The weekly cadence is revisited when the register's payout-speed trigger fires.
- The static-egress vendor is chosen at purchase; revisit if the proxy's cost or reliability becomes a measured problem.
- A traffic-light band stays red for two reviews in a row, which prompts a change to the lever it names.
- The accountant's answers on the principal model or the GST regime change a lever.

## Deprecated & Superseded Approaches

- **"Buy at go-live" for vendor plans.** The responder seat and Telemetry Nano (2026-11-01), Resend Pro (2026-11-08) and Supabase Pro "before the first real customer" (2026-10-31) are replaced by triggers and, for Supabase, by the first real-money booking.
- **The 2026-10-26 rejection of Sentry Team (ADR-09).** Replaced by a purchase of Team on a trigger kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend).
- **One GitHub Team seat (2026-11-07).** Replaced by one seat per active contributor.
- **QuotaGuard named as the one static-egress vendor (2026-11-01).** Replaced by an open choice behind `RAZORPAYX_EGRESS_PROXY_URL`.
- **Fee and referral amounts quoted in the 2026-11-08 record.** Replaced by the Growth & Marketing Lever Register.
