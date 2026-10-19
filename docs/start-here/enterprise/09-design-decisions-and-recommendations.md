---
title: Enterprise design decisions — recommendations, alternatives, and open choices
type: explanation
band: start-here
audience: sde3
status: partial
last-reviewed: 2026-10-19
---

# Enterprise design decisions — recommendations, alternatives, and open choices

This chapter turns the system design into explicit engineering and product choices. It describes what the reviewed implementation establishes, recommends an option, explains the alternatives, and identifies evidence that would justify a different decision. **Every proposed change below is a recommendation, not a behavior implemented by this documentation PR.**

The baseline is `dev` commit `dd0f8a3a0`, reviewed on 19 October 2026. The supporting chapters cite the schema, routes, helpers, workers and tests. No production configuration, live database, regulator approval, or vendor account was audited. Questions of commercial intent remain product decisions even when the underlying arithmetic is unambiguous.

## How to evaluate a choice

The default criteria are financial correctness, tenant isolation, recoverability, an understandable user experience, and the smallest implementation that satisfies a present workflow. A more configurable system is not automatically better. Each additional dimension must have understandable pricing, authorization, reversals, reporting and support behavior.

A recommendation becomes ready to implement when the triggering user flow, precise expected outcome, source of authority, retry behavior and acceptance evidence are written down. The design should avoid new flags, reconcilers, wrappers and state machines where existing mechanisms already enforce the required rule.

| Question                                    | Recommended direction                                                                                           | Main reason                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Should enterprise become separate services? | Keep transaction-sensitive enterprise behavior in the shared application.                                       | Membership, utilization and funding currently benefit from a common transactional boundary.    |
| How many configuration axes exist?          | Name the explanatory projection every time.                                                                     | Three, five and seven describe different views; none is a standalone end-to-end support proof. |
| What should an ordinary sponsor choose?     | Start with a small explicit commercial recipe.                                                                  | Support teams and buyers need predictable obligations before unusual permutations.             |
| What should PERSONAL overage mean?          | Describe the implemented full-card, program-metered path honestly before adding any incremental charge promise. | Its checkout call site bypasses sponsored overage settlement.                                  |
| How should money terms change?              | Use explicit replacement or supersession after locking.                                                         | Rewriting prior economics undermines invoices and earnings evidence.                           |
| Where should authorization live?            | Server permission and tenant checks, with UI using the same policy.                                             | Navigation visibility cannot protect an API.                                                   |
| How should asynchronous work persist?       | Retain existing state/outbox workers and repair their specific boundary.                                        | An additional generic queue does not automatically improve a durable, bounded job.             |
| What counts as compliance complete?         | Evidence of the whole operational workflow.                                                                     | A model or alert does not prove a statutory filing or successful vendor deletion.              |
| How should compute failover schedule jobs?  | Implement and verify the required active-platform switch before dual-fleet operation.                           | Job leases prevent concurrent overlap, but not every delayed duplicate run.                    |

## Decision 1: Keep one money spine and one database transaction where needed

**Current design.** Enterprise funding, utilization, accounting and payouts are integrated with shared booking and payment code. The database enforces several structural invariants. `lib/payments/webhooks/handlers.ts` supplies the payment confirmation pipeline; `postLedgerTxn()` supplies the shared journal posting boundary.

**Recommended option.** Preserve those shared semantics. Keep component boundaries in types, domain helpers and explicit transaction inputs. Move an operation to an independent service only when a measured capacity, ownership or isolation problem outweighs the cost of a distributed consistency protocol.

**Why.** A wallet debit plus entitlement consumption must either belong to the accepted booking attempt or roll back. A separate remote wallet service would need reservations, expiry, compensation and reconciliation for failures between it and the booking database. That is additional machinery with financial consequences.

**Alternative and revisit condition.** Separate export generation, outbound delivery or provider polling workers can be justified by runtime limits without separating accounting truth. A separate money service becomes reasonable if there is a demonstrated isolation requirement and a complete contract for reservations, retries and compensations. [Architecture boundaries](01-enterprise-system-design.md) and [operations](08-operations-and-integrations.md) explain the present design.

## Decision 2: Treat the axes as projections with explicit names

**Current design.** The reachability table in `lib/enterprise/reachable-paths.ts` is capability × funding source × program type. A five-axis settlement explanation also considers overage behavior and payout recipient. A seven-axis commercial view includes additional configuration such as surcharge, covered offering type and caps. The guidance classifier itself reads funding, program, overage behavior and surcharge.

**Recommended option.** Give every matrix its exact dimensions and purpose. Keep reachability, configuration validity, UI guidance, actual settlement and deployment availability as separate claims. Use the current code as evidence for each claim.

**Why.** A row in a three-axis table proves that a commercial shape is represented; it cannot establish how all partial refunds, lazy subscription allocations and postpaid overage paths behave. A seventh dimension that contains numeric ceilings also cannot be reduced to a finite number of uniform combinations without stating the sampled values.

**Alternative.** A single “all combinations work” matrix is concise but too strong. A giant exhaustive table is also hard to maintain and hides the actual algorithms. Prefer the smaller projections plus boundary examples and targeted tests. [Commercial axes](03-commercial-axes-and-programs.md) is the detailed explanation.

## Decision 3: Provide commercial recipes without backend refusal walls for unusual pairings

**Current design.** Funding and program metering are independent. `getPermutationGuidance()` classifies configurations as RECOMMENDED, ADVANCED or DISCOURAGED. `assertMergedOverageConfigValid()` still rejects nonsensical or unsafe configurations, such as charging overage with no positive required ceiling or attaching surcharge to BLOCK.

**Recommended option.** Present a small set of understandable recipes: prepaid rupee budgets, postpaid organization billing, and flat-fee engagement allowances. Keep supported unusual combinations accessible through the current progressive-disclosure design, with accurate obligations and examples. A “discouraged” label must explain the cost it warns about.

**Why.** WALLET plus LICENSED_SEAT can be valid: the program counts engagements while real prices debit cash. It still requires a per-engagement price limit and an intelligible wallet forecast. Hard-coding “seat means license” would remove a valid present configuration and confuse accounting units.

**Alternative.** Allowing every field with no guidance produces valid database rows that buyers do not understand. Banning all uncommon pairings contradicts the current product design. Keep validity checks for actual invalid terms; use explanation and confirmation for commercial complexity.

## Decision 4: Resolve the PERSONAL overage promise before extending its collection behavior

**Current design.** `recordCheckoutUtilization()` meters a selected program for PERSONAL funding, but calls `recordOverageAtCheckout()` only when `wasOverage && isOrgSponsoredPayment`. The PERSONAL booking already charges the member through its normal card path. A branch implemented inside a reusable settlement helper does not prove that this checkout invokes it.

**Recommended option.** Describe PERSONAL as personally paid access with program restrictions and metering. Make UI guidance match the actual call-site behavior. Before promising an additional surcharge or an organization-paid marginal on this rail, define the intended payer, amount, tax document, earnings treatment and refund mapping in a separate implementation change.

**Why.** If the learner has already paid the full service price, a second pass-through charge can charge the same base twice. Conversely, a UI that promises an organization-paid excess while the code simply charges the member can mislead procurement and support teams. Existing BLOCK metering and full-card payment do not by themselves implement incremental collection.

**Alternatives.** A genuine split payment could divide a single service price between member and organization, or PERSONAL could remain a reporting and curated-access rail with no extra collection semantics. The latter is the smaller default unless a current buyer flow requires the former. This is a documented design choice; this PR changes no configuration validation or money behavior. See [checkout and overage](04-checkout-and-overage.md).

## Decision 5: Keep metering units independent from prices

**Current design.** LICENSED_SEAT counts engagements; CREDIT_POOL tracks rupee-denominated consumption. A credit equals ₹1, or 100 paise. A price cap limits eligible price exposure and an overage ceiling limits cycle excess; they are different controls.

**Recommended option.** Name the unit next to every displayed allowance and every example. Explain count-based caps separately from price caps, wallet balance, credit limits and purchase-order ceilings. Keep these existing responsibilities distinct.

**Why.** A four-hour consultation can be one engagement while costing more than a shorter consultation. A wallet with ample cash can still fail program eligibility. A member with unused engagement count can still select an offering outside its covered plan types or allowed panel.

**Alternative.** A universal “credits remaining” number is convenient but makes count and money appear interchangeable. That produces support errors and misleading forecasts. A future normalized display can summarize several measures only if it preserves their underlying unit and explains which constraint will actually block a booking.

## Decision 6: Preserve per-allocation subscription evidence

**Current design.** Subscription service is allocated incrementally. The utilization model and usage ledger associate consumption with concrete appointment identities, while overage can be associated with a metered batch. Those identities also matter to reversals.

**Recommended option.** Retain CREDIT_POOL per-session value metering, LICENSED_SEAT engagement-count metering, batch overage identity, and exact reversal matching. The seat path records the parent payment value once for sale/reversal evidence; it does not re-debit that full value for every later allocated appointment. Examples and future tests should include allocation crossing a cap, retrying the same allocation, cancelling one session, and allocating another after a partial reversal.

**Why.** Charging the whole subscription budget at signup can consume allowance before service times exist. Keying every overage to the parent payment alone cannot represent more than one later batch crossing a boundary. Reversing a guessed proportion after a partial cancellation can restore the wrong credit balance.

**Alternative.** Coarser per-subscription metering is easier to describe, but changes the current semantics and loses the information needed for partial outcomes. Revisit only for a deliberately different product with clearly defined upfront entitlement consumption. [Programs](03-commercial-axes-and-programs.md) and [overage](04-checkout-and-overage.md) explain the implementation.

## Decision 7: Make overage ceilings explicit in both units and scope

**Current design.** The charging configuration requires a positive ceiling where the validator applies. `recordOverageAtCheckout()` sums active excess obligations for the cycle context and checks the prospective charge before creating its event. The ceiling uses tax-exclusive base plus surcharge; selected failed or reversed outcomes release exposure. Program configuration and per-assignment usage are distinct scopes.

**Recommended option.** Explain precisely which assignment or carried cycle the ceiling covers. Display the ceiling unit as rupees with tax treatment explained. Do not label it “whole-company maximum spend” unless a separate organization-wide control actually enforces that promise.

**Why.** If an example has 100 assignments, an assignment-scoped ceiling of ₹2,000 does not imply a ₹2,000 total organization exposure. The organizational forecast must combine the relevant assignments and other funding obligations. Tax-inclusive cash needs can also exceed a tax-exclusive circuit-breaker value.

**Alternatives.** A true shared organization overage budget could be useful for an active procurement requirement, but would require a shared reservation and concurrency design. Do not add it merely to make the wording of a dashboard total easier.

## Decision 8: Choose member co-pay according to collection risk and booking experience

**Current design.** CHARGE_MEMBER uses a parent-funding carve and a separate deferred child pay-link, with earnings holds and collection outcomes. This path is not a single booking payment split synchronously across organization and member tender. The exact route depends on the booking/allocation path and funding rail. A learner seeing a successful underlying booking does not prove that every additional obligation has been collected.

**Recommended option.** For a future co-pay redesign, prefer collecting a known required amount synchronously when the learner can decide before committing. That would require a deliberately implemented path; the reviewed CHARGE_MEMBER path uses deferred collection. Keep post-hoc collection for workflows that genuinely discover the marginal later, such as later allocation. Always show the member what remains payable and show finance whether collection is pending, failed or settled.

**Why.** Synchronous collection reduces unsecured debt and support follow-up. Post-hoc collection supports lazy allocation but needs a durable debt identity, timeout behavior, payout eligibility checks and a refund story if only part of service is cancelled.

**Alternative.** Paying the expert immediately and hoping the member later pays transfers collection risk to the platform. A deliberate platform-funded guarantee could be a product choice, but it must be priced and accounted for; it should not emerge from a missing hold check.

## Decision 9: Keep the journal authoritative and caches purposeful

**Current design.** The immutable journal is financial evidence. The wallet keeps a cached balance for the atomic sufficient-funds check. `walletDebit()` initializes a NULL cache to zero before arithmetic and conditionally decrements only a sufficient balance.

**Recommended option.** Preserve the cache's narrow operational purpose. Explain journal versus cache in finance views, use the existing controlled repair paths for a discrepancy, and avoid introducing another balance log or a general JavaScript invariant sweep.

**Why.** Recomputing the entire journal for every interactive debit would make a simple concurrency guard expensive. Treating the cache as an independent accounting truth creates a second authority. The design needs the journal for evidence and the conditional cache update for safe spending.

**Alternative.** Removing the cache could be viable with a different, proven database debit design. Adding a second wallet ledger recreates a superseded architecture and multiplies reconciliation work. Read [settlement](05-ledger-billing-and-settlement.md) for the actual posting paths.

## Decision 10: Use database guarantees for structural invariants

**Current design.** Checked-in SQL sidecars enforce journal balance, journal immutability, funding-leg coherence, nonnegative money and selected overlap rules. They have exact predicates and exemptions.

**Recommended option.** Verify installation through existing deployment checks and test the applicable sidecar behavior. Reconcile across provider boundaries or repair unfinished work; do not add application sweeps to re-verify every row for a state PostgreSQL already refuses at commit.

**Why.** A sweep detects corruption after it exists, consumes operational budget, and can teach maintainers that invalid rows are expected. The commit-time guarantee blocks the invalid state at the source. Conversely, it cannot prove a Razorpay transfer happened or that a tax category is legally correct.

**Alternative.** App-only assertions are useful for readable errors but weaker as the sole enforcement. A database constraint is also insufficient for business rules involving tentative holds, co-hosts or attendee capacity that its predicate does not cover. Use the narrowest correct enforcer and state its boundary.

## Decision 11: Change commercial terms by version, replacement or supersession

**Current design.** A program persistently locks money fields when assignment usage begins. Contract terms lock after leaving DRAFT or acquiring relevant obligations. Rate cards and earnings carry their own historical context.

**Recommended option.** Keep the current immutable-history approach. Give operators a clear preview of the replacement terms, effective period and which members move. Preserve existing bookings, invoices and earnings against the version that created them.

**Why.** A mid-cycle edit from BLOCK to a marked-up charging policy is a commercial change, not a harmless label correction. Recomputing prior bookings under it would rewrite obligations that members and finance already accepted.

**Alternative.** A generic “pending config applies later” state machine could support richer scheduling, but the current archive/replacement and contract supersession mechanisms already satisfy the documented lifecycle. Add deferred configuration only for a concrete flow that those mechanisms cannot express.

## Decision 12: Keep authentication, membership and authorization distinct

**Current design.** Global identity, per-organization membership, SSO policy, role permissions and tenant predicates are separate. `lib/auth/org-permissions.ts` defines the organization permission policy. `Membership` has one role per user per organization.

**Recommended option.** Treat SSO as identity assurance and organizational entry policy, then authorize the requested action against current membership and scope. Keep finance powers separate from people administration. Read the permission by its action name rather than assuming every higher-looking role inherits it.

**Why.** A billing administrator needs invoices and payouts without needing access to SSO secrets or employee removal. An EXPERT may deliver work while lacking procurement rights. A platform consultant role cannot authorize organization administration.

**Alternatives.** Switching wholesale to a generic organization plugin or inventing a new permission service would create migration and consistency work. A richer multi-role model could become justified by an actual same-organization learner/expert/operator requirement, but requires explicit conflict rules and migration from the current single-role membership.

## Decision 13: Keep dashboards aligned with actor and data scope

**Current design.** Personal dashboards, the cross-organization workspace, per-organization dashboards and platform backoffice serve different actors. The organization appointment surface also separates operator, payer, attendee and deliverer perspectives.

**Recommended option.** Preserve the distinct scopes while sharing presentational components and query conventions where useful. Route every visible action to an API that independently checks permission and organization ownership. Make the active company and actor perspective visible when one person can use several contexts.

**Why.** An organization owner who also buys personal consultations should not accidentally expose those sessions to finance. A workspace total across several companies is a personal navigation convenience, not authority to act in each company.

**Alternative.** A single universal dashboard can reduce navigation count but increases ambiguous ownership, privacy risk and conditional UI complexity. Consolidate only where users actually need the combined view and each row retains its origin. [Dashboard design](06-dashboards-and-user-journeys.md) covers individual pages and APIs.

## Decision 14: Describe organization visibility and service visibility separately

**Current design.** The public organization directory can list opted-in ACTIVE organizations, including sponsor-only organizations. Plan visibility has its own PUBLIC, ORG_ONLY and ORG_AND_PUBLIC semantics. Host activation also has a feature gate.

**Recommended option.** Keep these policies separate in product language and query predicates. An organization can publish its brand without promising a public expert catalog. An internal plan must remain protected even when its organization is public.

**Why.** Requiring `canHost` for all directory entries makes sponsor discovery disappear while hosting is gated. Treating an organization listing as permission to expose every related plan or recording expands the public surface far beyond its owner's choice.

**Alternative.** A future “organization storefront” setting may bundle specific choices for convenience, but it should apply existing policies explicitly instead of replacing their individual authorization checks.

## Decision 15: Make removal an obligations-aware orchestration

**Current design.** Membership removal, suspension, erasure and organization deletion are distinct actions. Financial relationships can require retention. Existing removal helpers inspect and act on obligations; the erasure pipeline scrubs identity and stages external work.

**Recommended option.** Continue to distinguish stopping access, cancelling future commitments, settling money and removing personal identifiers. Give the operator a truthful preview of blocked or outstanding obligations. Keep financial history attached to its preserved identifiers.

**Why.** A direct cascade deletion can destroy evidence needed for refunds, withholding returns, invoices and disputes. Leaving future sessions untouched can strand an expert or learner. A successful local scrub alone does not prove a vendor deleted its copy.

**Alternative.** A one-click “delete everything” operation has a simple UI but requires many inconsistent meanings behind it. A single orchestration endpoint can still be useful if its visible outcome and durable progress reflect the actual separate obligations.

## Decision 16: Preserve and observe the existing erasure retry machinery

**Current design.** `scripts/cleanup/retry-moderation-enforcement.ts` drains `StreamRevocationRetry` and `VendorErasureRetry`, then finalizes eligible requests. The registry exposes the job and the Netlify ticker includes its 30-minute schedule. The scrub pipeline creates durable vendor work alongside local changes.

**Recommended option.** Retain that worker and make oldest pending age, failed attempts and completion blockers visible in existing operational views. Follow the current worker from producer through registry to scheduler before claiming a missing component.

**Why.** The worker's file name refers to moderation, so a search limited to `lib/compliance` can miss a functioning consumer. Adding another drainer would create duplicate orchestration and an unnecessary ownership problem.

**Alternative.** A rename or small organizational cleanup may improve discoverability if maintainers repeatedly miss the worker. It is a documentation and ownership choice, not evidence that the retry pipeline must be rebuilt. [Compliance](07-compliance-privacy-and-data.md) and [operations](08-operations-and-integrations.md) trace the actual path.

## Decision 17: Treat statutory reporting as a complete workflow

**Current design.** The application contains tax models, calculation helpers, invoice generation, IRP-related code, breach intake, grievance tracking and reminders. Some fields or integration edges remain partial. Readiness differs by component.

**Recommended option.** For each statutory obligation, identify an accountable owner, trigger date, required evidence, external recipient or portal, delivery mechanism and completion record. Use the existing admin and durable job architecture where it fits; require evidence before calling an automated filing active.

**Why.** A `DataBreach` row plus reminders does not establish that the Board or affected people were notified. An IRN payload mapper does not establish that every eligible invoice was accepted by an IRP. A calculated TDS amount does not establish that a return was filed under the correct law code.

**Alternative.** Manual completion can be a valid current operating model when ownership and evidence are explicit. Calling an incomplete connector “automated compliance” obscures the missing human step. External legal facts and the implemented boundaries are documented in [compliance](07-compliance-privacy-and-data.md).

## Decision 18: Keep tax classification and dates in durable evidence

**Current design.** The schema includes TDS law-code metadata and rates, and the code has date-sensitive tax behavior. Organizations also store tax, MSME and invoice identifiers. A company display name is not necessarily its legal deductee identity.

**Recommended option.** Preserve the law code, applicable date, rate and identity snapshot with financial evidence. Examples should state their tax assumptions. A future legal change should affect new applicable events and correction rules, rather than silently rewriting old payouts.

**Why.** The Income Tax Department's transition guidance uses the earlier credit/payment event to select the governing Act around 1 April 2026. Payment date alone can therefore select the wrong regime. See the official [TDS transition FAQs](https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/%20tds%20compliance-faq).

**Alternative.** A single globally configured percentage cannot represent residency, legal category, thresholds, exceptions and historical corrections. A fully configurable tax engine would also be excessive without present needs; use the implemented typed tax components and explicit review for classifications that remain uncertain.

## Decision 19: Separate INR settlement from reporting or residency labels

**Current design.** Currency and data-region fields exist, while the reviewed journal and settlement model remain INR-based. `AccountRef.currency` in `lib/payments/ledger/post.ts` explains the settlement boundary.

**Recommended option.** Describe reporting currency and regional intent as stored attributes until the corresponding execution guarantees are demonstrated. Offer a cosmetic foreign-currency display only with clear conversion assumptions. Promise regional isolation only when application, database, storage, logs, backups and vendors all satisfy the stated boundary.

**Why.** Labeling INR paise as USD does not convert it. Selecting EU in a tenant field does not move its records or stop an integration from transmitting data elsewhere. Both promises have architecture and contractual consequences.

**Alternative.** Full FX settlement or regional deployment can be designed for an active international contract, but requires its own ledger, tax, pricing, storage and operational design. Do not infer either capability from an enum.

## Decision 20: Keep existing durable jobs before adding a general queue

**Current design.** Database state and specific outboxes drive payment recovery, notifications, exports and vendor retries. The cleanup registry supplies common HTTP/admin dispatch, and `withCronLock()` supplies Postgres leases. Latency-sensitive and batch work have different schedules.

**Recommended option.** First measure backlog age, worker runtime, provider latency and completion rate. Tune an existing bounded job only within its actual constraints. Introduce a separate queue when demonstrated latency or throughput needs cannot be satisfied by the current consumer model.

**Why.** A queue supplies delivery and execution facilities; it does not decide tax, prevent a duplicate payout, or repair a missing business transition. Moving unfinished state to a new transport can multiply retries without making its handler idempotent.

**Alternative.** A queue becomes useful for sustained work, shorter latency requirements or independent worker capacity. Its design must retain stable operation identities, backpressure, retries and visibility. Avoid creating another implementation plus cron wrapper plus script wrapper for the same business function.

## Decision 21: Implement scheduler fleet ownership before active/standby dual scheduling

**Current design.** Repository instructions require an Upstash `ops:active_cron_platform` switch. The reviewed `netlify/functions/cron-tick.mts` does not read that key before dispatch. The Postgres lease does coordinate overlapping runs of a job, but is not a complete active/standby ownership protocol.

**Recommended option.** Implement and verify the required switch in a separate code PR before running schedulers from both fleets. Keep the switch check at the scheduler boundary and keep job locks in PostgreSQL. Demonstrate that standby dispatch stops while manual authorized recovery remains possible.

**Why.** Fleet A can finish a job and release its lease before fleet B dispatches the same scheduled run. Both can then run sequentially. Idempotency may protect money, but notifications or other effects can still repeat and provider load increases.

**Alternative.** Operating only one scheduler manually can be a temporary deployment posture, but it must be explicit. Adding Redis locks to every cron duplicates the existing lease mechanism and does not solve ownership cleanly. [Operations](08-operations-and-integrations.md) records the implementation boundary.

## Decision 22: Make host portability include identity and cache boundaries

**Current design.** Netlify deployment remains part of the repository. The reviewed IP selection in `lib/rate-limit.ts` accepts the Netlify header without the required runtime predicate, and the auth IP header list includes multiple platform headers. Cookie-aware public caching also requires scrutiny per route.

**Recommended option.** Enforce the runtime-specific trusted header order in a separate code change, verify equivalent rate-limit behavior on each host, and use standard `Vary: Cookie` alongside platform-specific cache signals where the route depends on cookies. Preserve the current Netlify configuration while adding another active platform.

**Why.** A header trusted because a platform sets it may be client-controlled on a different platform. A cache-key instruction understood only by one host cannot be assumed to protect another host's responses. Portability includes security and privacy behavior, not just a successful build.

**Alternative.** A universal forwarded-header policy could be correct behind a verified shared proxy, but would need that proxy trust contract and tests. Do not silently assume it from current hosting names. These are reviewed source gaps, not claims that a production exploit occurred.

## Decision 23: Make integration recovery visible without creating a new dashboard product

**Current design.** The application has organization audit, platform system events, job execution history and existing finance and support backoffice surfaces. They carry different evidence and access policies.

**Recommended option.** Expose a few operationally meaningful measures in the relevant existing surface: oldest unfinished obligation, last successful execution, failed attempts, and an authorized next action. Keep organization members' evidence sanitized and platform diagnostics restricted.

**Why.** An organization finance user needs to know why an invoice or payout is waiting, while platform staff may need provider identifiers and error context. Showing the same raw operational payload to both creates avoidable privacy and security exposure.

**Alternative.** A universal enterprise operations console could be justified by a demonstrated support workflow. Adding it before identifying its actors and commands would duplicate several dashboards and expand authorization complexity.

## Decision 24: Use measurable capacity examples, not invented throughput guarantees

**Current design.** The ticker has target-specific batch limits, cadences and request deadlines. Runtime pools and provider budgets constrain each worker. This documentation does not benchmark a production deployment.

**Recommended option.** State proposed service objectives as targets, then validate them with mock-backed load tests and observed job metrics before treating them as a capacity promise. Model both a backlog spike and steady incoming work.

For illustration, a worker that can complete 20 rows every 10 minutes has a theoretical upper bound of 120 rows/hour if every run succeeds and every row fits its budget. A backlog of 240 rows requires at least two hours with no new arrivals. This arithmetic is an illustrative planning model, not a measured rate for Familiarise's export or notification workers.

**Why.** Increasing a limit can cause deadline overruns and lower completed throughput. An eight-second provider request multiplied by a large batch can exceed a serverless budget even when the database is fast. Queue age reveals customer impact more clearly than run count alone.

**Alternative.** Scaling worker concurrency is sensible when provider limits and database contention allow it. Increasing every pool and batch setting at once hides the bottleneck and can make recovery less reliable.

## Decision 25: Keep external operation identity stable through ambiguous failures

**Current design.** Payments, webhook events, ledger transactions, top-ups and payouts each have operation-specific identities. The payout implementation derives a provider-compatible key from the payout identity. The journal also has its own unique idempotency key.

**Recommended option.** Preserve the same identity for retries of an uncertain provider operation. Investigate or fetch its current state before creating a new economic operation. Document when a terminal failure allows a genuinely new attempt and how the local model represents it.

**Why.** An HTTP timeout does not prove the provider rejected a transfer. Razorpay's current documentation explicitly warns that a fresh key while the original payout is processing can create a duplicate transfer. See [Razorpay payout idempotency](https://razorpay.com/docs/api/x/payout-idempotency/).

**Alternative.** A new key for every retry improves apparent request success while risking duplicate money movement. A single universal idempotency key across unrelated components is also insufficient: capture, utilization, invoice issuance and payout have different economic meanings and lifetimes.

## Decision 26: Treat export links, errors and recovery as a privacy component

**Current design.** The worker generates an export, stores a signed URL, and can send that direct URL through email and Novu. The download API rechecks current organization authorization, but an already distributed storage URL is a bearer capability outside that later check. A failed job exposes its stored `error` through the authorized organization list API; the worker currently copies the caught exception message into that field. FAILED is terminal in the worker, and a crashed PROCESSING claim has no demonstrated automatic reclamation.

**Recommended option.** Notify with an authenticated dashboard link and issue a short-lived storage URL after the current role/kind check. Store a customer-safe error code and message on the job, with raw detail confined to `SystemEvent`. Define bounded stale-claim recovery, authorized regeneration, and separate object-deletion and job-evidence retention policies through the existing job machinery.

**Why.** Removing a member can block the dashboard without revoking a seven-day URL they already copied. A sanitized audit log also cannot protect a different API field containing a provider or Prisma error. Expiring a URL does not delete its storage object, and marking a job PROCESSING does not supply a crash-recovery consumer.

**Alternatives and evidence.** A longer direct URL can be an accepted convenience tradeoff if its residual exposure is explicitly approved for the exported data. It should not be described as revocable through current membership. A versioned field manifest and tests for PEOPLE/FINANCE permissions, provider-shaped errors, stale claims, link expiry and field-level consent provide reviewable acceptance evidence. The tenant administrative bundle remains distinct from an individual's data-access response. [Compliance](07-compliance-privacy-and-data.md) traces the current worker and API.

## Decision 27: Add consent specificity only with the required user journey

**Current design.** Consent artifacts store purpose, fiduciary and notice version. The shared processing predicates currently check user, purpose aliases, withdrawal and retention; they do not enforce the current notice version or a particular fiduciary. Organization consent APIs have their own scoped reads and writes. The single-user helper accepts a transaction client; the batch helper currently uses the global client.

**Recommended option.** Define which purpose requires a platform or organization grant, then implement any tighter predicate together with the appropriate prompt, notice registry and re-consent flow. Retain transaction-client discipline if the batch helper ever needs an interactive transaction caller.

**Why.** Stored metadata alone does not enforce a policy. Adding a predicate without a way for existing users to grant the new required artifact can deny legitimate bookings or exports. Treating an organization-scoped grant screen as proof of a fiduciary-specific shared gate would overstate the current behavior.

**Alternative.** Purpose-only platform grants may be the deliberate policy for some processing. Preserve that where reviewed and appropriate; do not create a generic consent state machine merely to fill every possible field. The active processing purpose and fiduciary relationship should drive the smallest required change.

## An example decision walkthrough

Suppose a procurement buyer asks for “one shared budget, unlimited sessions, employee overages, public experts, and an EU tenant.” The correct design exercise separates those words into existing dimensions and unanswered promises.

First, decide whether “shared budget” means a prepaid wallet, a postpaid credit limit, a purchase-order ceiling, or per-member program allocations. Those are existing but different controls. Second, decide whether unlimited means no engagement-count cap, no per-engagement price limit, or no financial exposure ceiling. The latter is a much larger commercial promise.

Third, define when the employee owes a marginal and how it is collected. Unlimited engagement count makes count-based excess settings ineffective, while a rupee budget can still have a financial boundary. Fourth, publish only the desired public brand and offering visibility, keeping internal recordings and membership private. Finally, treat EU residency as a contractual deployment requirement requiring proof across vendors, rather than setting `DataRegion.EU` and declaring completion.

The recommended outcome is a clear supported recipe with explicit constraints and a separately scoped proposal for any missing requirement. This produces a reviewable commercial design without adding speculative configuration to the runtime.

## Questions that need an owner decision before a future behavior change

These questions do not block the docs PR because the current implementation is documented. They do block silently changing the corresponding product or financial semantics.

| Choice                                    | Recommended default                                                                | What the decision must specify                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| PERSONAL incremental overage              | Personally paid access and metering without an unimplemented extra charge promise. | Whether excess is an access boundary, member surcharge, or a genuine sponsor split; tax and reversal rules. |
| Shared organization ceiling               | Retain existing scoped controls until a buyer requires a shared cap.               | Reservation scope, concurrency, invoice/wallet interaction, and what cancellations restore.                 |
| Post-hoc member collection loss           | Keep earnings held according to current collection rules.                          | Who bears an unpaid debt, timeout consequences and whether service remains usable.                          |
| Regional data promise                     | Promise only demonstrated deployment behavior.                                     | Included systems, allowed transfers, backup locations and vendor commitments.                               |
| Automated statutory reporting             | Explicit current human owner where delivery is not automated.                      | Filing recipient, deadline clock, evidence, escalation and completion authority.                            |
| Same-person multiple roles in one company | Preserve the current one-role membership model.                                    | A concrete workflow and resolution of conflicting permissions or payout identities.                         |
| New queue or service                      | Measure the existing consumer first.                                               | Required latency, sustained rate, operational ownership and idempotent handler contract.                    |

## Evidence that would change these recommendations

A paying customer with a concrete multi-subsidiary approval workflow could justify hierarchy and scoped delegation. A measured recovery backlog that misses agreed service objectives could justify independently scaled workers or a queue. A signed cross-border contract could justify a full FX and regional design. A current same-organization dual-role use case could justify changes to the membership model.

Each would be new evidence for a new design. None should be implemented from a schema reserve, an old document, a theoretical possibility, or a desire to make the subsystem appear more “enterprise.”

## Glossary

- **Projection:** A deliberately limited view of a larger configuration space.
- **Acceptance evidence:** Observable results that establish a proposed design works, including negative and retry cases.
- **Economic operation:** One intended movement or recognition of money, with a stable identity.
- **Ambiguous failure:** An error where the caller does not know whether the remote side accepted the operation.
- **Exposure:** Money already owed or potentially committed under the selected scope and terms.
- **Service objective:** A proposed or agreed operational target, rather than an observed guarantee.

## Deprecated & Superseded Approaches

Treating every organization as exactly one exclusive commercial kind obscured hybrid buyers and hosts. The current capability pair should remain the source of that distinction; taxonomy is a separate concern.

Collapsing funding and metering into fixed pairs made a wallet-backed engagement allowance look invalid. The current design supports independent choices with guidance and real validity checks. Reintroducing broad refusal walls would reverse that product decision.

Calling a helper branch “supported end to end” without inspecting its callers led to inaccurate PERSONAL-overage claims. The reviewed call path is now the standard of evidence. Future support declarations should include collection, reversal and reporting behavior.

Charging or restoring a subscription only at the parent-payment level lost the identity of later allocation batches and partial outcomes. Current usage and overage identities should be preserved rather than replaced by coarse approximations.

The former single-entry financial logs are not additional authorities to resurrect. Journal postings and purposeful caches have distinct responsibilities, and corrections use compensating entries.

A JavaScript sweep that re-proves commit-time database invariants is a weaker and more expensive form of assurance than installing and testing the existing sidecars. Provider reconciliation remains necessary because PostgreSQL cannot constrain a vendor's database.

Using an organization owner or generic administrator as the answer to every permission question obscures finance delegation and privacy boundaries. Current action permissions, membership roles and scopes should lead both UI and API design.

Equating local erasure with completed vendor erasure misses the durable retry workers already present. Rebuilding that pipeline under a new name would duplicate rather than close the boundary.

Assuming job locks imply active/standby scheduler ownership misses sequential duplicate dispatch. The existing Postgres lease should be retained while the separate required fleet switch is implemented and verified.

Finally, stored enums, feature code and old integration maps cannot prove international settlement, regional hosting or automated regulatory delivery. Those promises require current operational evidence. This chapter records the recommended direction without presenting a proposal as shipped behavior.
