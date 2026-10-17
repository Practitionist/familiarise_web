# Explore and booking UI refresh

UI and booking-journey improvements against dev, plus the user-approved generated curriculum brochures for classes and subscriptions. No schema, availability-engine, gateway-payment, or authentication-policy changes. The two new PDF routes include deployment tracing for the existing React runtime and bundled fonts. The latest follow-up adds a selected-offering preview and explicit consultation checkout recovery.

The same PR now includes the approved Familiarise logo and customer-first landing page. See the separate [landing and brand review](../landing-refresh/README.md) for assets, architecture, visual decisions, verification, and captures.

## Confirmed design decisions

| Decision                   | Chosen direction                                                                                                       | Tradeoff                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Heroes                     | Restore each page's actual dev treatment                                                                               | Preserves the original layouts and animations instead of imposing one header on every page         |
| Theme                      | Original animated black listing heroes; light content and booking surfaces                                             | No app-wide theme switch; unrelated dark routes and tokens remain intact                           |
| Detail headers             | Original expert profile card, full-width class/webinar image gradients, and unboxed consultation/subscription headings | Detail types keep their distinct identities                                                        |
| Expert portrait/navigation | One right-side desktop portrait with avatar fallback, stacked on mobile; inline Experts breadcrumb                     | Keeps direct arrivals navigable without a second full-width navigation bar                         |
| Expert offering preview    | Short outcomes/inclusions and up to three authored milestones linked to full details                                   | Replaces the read-only calendar; scheduling remains in booking                                     |
| Plan choice                | One page-local plan identity drives the preview, price, details and booking                                            | Named radio choices distinguish equal-duration plans; no control for a single plan                 |
| Calendar loading           | Neutral skeleton + “Checking available dates…” until month availability is known                                       | No clickable numbered dates or misleading availability outlines during the initial month load      |
| Subscription/class content | Details page + optional curriculum download                                                                            | The page remains the accessible, bookable source; the PDF supports offline review and sharing      |
| PDF production             | Generate from current plan content                                                                                     | One source of truth, but less custom branding than uploaded brochures and a short preparation wait |
| Consultation booking       | Date/time together on desktop; Date → Time → Review on mobile                                                          | Adds confirmation before the existing checkout/approval action                                     |
| Mentorship                 | Start date → cycle review → existing checkout                                                                          | Makes the first-cycle boundary visible before payment                                              |
| Mentorship price           | Total plan price, not “per month”                                                                                      | Matches the existing one-time charge; no billing change                                            |
| Group programs             | Registration review before existing sign-in/checkout                                                                   | Retains eligibility, capacity, event IDs, cancellation disclosures, and callbacks                  |
| Carousel                   | Manual navigation                                                                                                      | Stable content while reading; another item takes a click                                           |

## Scope

- Expert/program directories, cards, filters, skeletons, and expert quick view.
- Expert profiles and consultation, subscription, class, and webinar detail pages.
- Responsive pricing segments, guided booking dialogs, timezone labels, mobile booking actions, and selection/focus persistence.
- Shared calendar shells, date-cell accessibility, appointment-day expansion, and planner price/currency fields.
- Booking dialogs clear the navigation stack. Refreshed, missing, expired, or loading slot windows cannot be submitted as stale selections. Allocation changes use the current window's approval policy.

Directory hero markup/animation and navigation integration remain restored from dev. Class/webinar heroes retain the original image dimensions, gradient, overlays, typography, and back navigation through a shared component. Consultation/subscription detail headings remain original. The expert profile retains its original light-card treatment, with the approved portrait placement and compact breadcrumb updates. The superseded editorial hero component and dark header overrides are removed.

## Frontend system design

| Surface          | Responsibility                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Explore Experts  | Discovery and profile entry; retain filters and original animated black hero                                        |
| Explore Programs | Classes/Webinars discovery only; consultation and mentorship remain discoverable through experts                    |
| Expert details   | Trust and offering evaluation; one controlled selection across curriculum preview, price, details link and purchase |
| Program details  | Complete offering evaluation, authored curriculum and optional PDF; preserve fixed class/webinar schedules          |

The public profile performs no month/week availability reads until the consultation dialog opens. Closing/unmounting that dialog disables those reads. Service changes clear the selected slot; plan changes invalidate the review/incompatible choices. Subscription purchase continues to buy an entitlement: dates are arranged with the expert afterwards, not reserved by the start-date picker. The public preview fetch selects only three milestone IDs/titles/order/outcomes, excluding learner resource URLs; full curriculum and PDFs stay on the plan pages.

Consultation availability refusals offer “Choose another time,” preserve the plan in the profile return URL, discard the rejected slot and refresh both month/week answers past query and browser caches. Definitive refusals disable payment attempts against that selection. Structured transient busy retries remain unchanged. “Your card has not been charged” is shown in this recovery only when the response explicitly establishes it. Gateway APIs, lock/hold logic and transactional allocation are unchanged.

## UI system design

The selected offering sits immediately after the profile header, before the longer biography. Service categories remain tabs; plan purchase choices are accessible radio cards labelled with their real names and durations. A single-plan offering hides the selector. Mobile actions name the selected offering and service. The right portrait falls back to the existing circular avatar; only one image is displayed. The loading skeleton mirrors this layout instead of showing a page-level calendar or duplicate back bar.

Consultations with no authored inclusions show factual session duration, not fabricated document verification or support claims. The blanket “Money-back” chip is removed; “Verified” follows the actual expert flag. The booking and refund terms remain on the existing details/checkout surfaces. No app-wide theme mechanism or dark-mode scope changes.

## Booking follow-ups

- [#1907 — Booking correctness: availability, holds, allocation, and payment reconciliation](https://github.com/Practitionist/familiarise_web/issues/1907): policy parity, selected-duration month marks, buyer-conflict display, non-INR consultation display parity, constraint deployment/coverage, all booking writers, real PostgreSQL/Redis races and late-capture refund recovery.
- [#1908 — Unified subscription scheduling workspace](https://github.com/Practitionist/familiarise_web/issues/1908): one expert/client workspace, preferences and versioned batch proposals, counterproposals, atomic allocation, draft persistence, conflict explanations and rollout metrics. Includes separate frontend-system and UI-system recommendations.

Both issues carry the `booking` label. Source inspection found existing checkout locks, revalidation, tentative holds and retried Serializable transactions; dashboard busy/free derives from the unified grid rather than a second occupancy join. These observations and passing unit tests are not production concurrency certification. The confirmed-only overlap constraint excludes tentative holds, and deployed installation has not been verified. The issues explicitly distinguish verified behavior from risks that still need investigation.

Monthly availability loading is separate from daily/weekly time-slot loading: fetching times does not blank an already-loaded month. A failed month read has a distinct message and plain selectable dates so visitors can check times individually; it does not pretend that every date has availability.

## Curriculum PDFs

Both subscriptions and classes retain their dedicated details page and complete on-page roadmap/course content. An authored, non-empty curriculum enables a secondary “Download curriculum (PDF)” action below that section. With no curriculum, there is no empty brochure card or download action. Booking stays on the page and remains the primary action.

Each request generates a fresh brochure containing the plan overview, mentor name, duration/cadence/level/language, audience, outcomes, inclusions, prerequisites, and ordered/grouped curriculum. It includes a generated date and link back to the plan. Current prices, dates, seats, and booking terms are deliberately left to the page. The layout uses a charcoal overview header, clean curriculum dividers, wrapping text, and page numbers.

The download endpoints reuse the detail page's visibility gate and fresh session checks, including organization-only access and authorized owner previews. Unauthorized or missing plans return a generic 404. PDFs are private/no-store, rate limited independently (6/minute/IP), and use an explicit buyer-facing-content allowlist. Participant data, emails, material/file URLs, and lesson-content URLs are excluded. Existing learner materials and uploaded PDFs are not made public. There are no uploads, stored brochure files, new database fields, or additional dependencies.

The button prevents duplicate requests, shows preparation progress, offers accessible/retryable errors, and releases its temporary download URL. The generated PDF is a convenience export, not a replacement for the accessible HTML page; tagged-PDF accessibility is not claimed.

## Verification

### Latest offering-preview follow-up

- **92 tests across 22 focused suites pass**, covering controlled plan selection, duplicate durations, preview/price/details consistency, single-plan controls, lazy availability, query/browser-cache bypass, gateway refusal recovery, honest charge copy, public milestone projection, booking review, PDFs, hold expiry and lock lifetime.
- Changed source/tests pass ESLint and formatting; the focused TypeScript check includes changed roots, ambient declarations and transitive imports with zero diagnostics.
- Completed 1440px desktop and 390px mobile fixture checks: right-side portrait, compact breadcrumb, shared consultation/mentorship selection, no availability reads during browsing, start-date/time review and Back persistence, delayed neutral calendar skeleton without numbered dates, no horizontal overflow or page exceptions. No booking/payment write was submitted.
- Regenerated English/Hindi/long-content PDFs preserve all 12 sample items and page numbering; the long sample spans five pages. Customer-facing footer text and no printed raw URL were checked. The current overview/sample below were regenerated.

### Earlier restoration and broader surface checks

- Latest follow-up: 14 targeted Jest suites, 83 tests passing. Includes month skeleton/loading/error states, slot-selection safeguards, subscription review, PDF content allowlisting, fresh-session/visibility handling, no-curriculum behavior, rate limits, download success/error/pending behavior, JSX-runtime compatibility, plan visibility, and curriculum labels/order.
- Changed/new TypeScript sources and tests pass ESLint and formatting. Git diff whitespace checks pass.
- Focused TypeScript check: changed roots, ambient declarations, and their transitive imports; zero diagnostics. This is not a full-project type-check claim.
- Successful browser checks at 1440px desktop and 390px mobile: transparent navigation over the original listing hero, original animation classes, detail layouts without horizontal overflow, and secondary PDF actions. The Experts directory was checked on its real route; the other surface captures use isolated production-component fixtures.
- Calendar browser checks use the actual availability hooks with delayed read-only responses: no numbered dates while loading, only three fixture dates marked after loading, daily loading retaining the month, and uncached-month navigation returning to the skeleton. No booking submission was made.
- PDF download preparation, a real generated-file download, and a deliberately injected/retryable HTTP 500 were checked in the browser. No page exceptions occurred in the completed fixture pass; that expected 500 was the only console error.
- Actual exported A4 PDFs were rendered and inspected in English and Hindi. A long overview and an individual curriculum description longer than a page wrap without dropping the final content or page numbers. These are synthetic fixtures, not customer documents.
- The original UI iteration passed 128 tests across 20 targeted suites and CI lint/type-check/tests/build. The earlier charcoal revision also passed CI. This latest follow-up must run CI again after push.

### Limits

Earlier live detail-page checks encountered database connection timeouts, so fixtures do not verify production availability or payment integrations. A repeat capture of the latest surfaces later stalled in the local development server; it is not counted as a pass. The completed captures and assertions above remain available. Temporary preview routes are removed before commit.

The original full-project TypeScript attempt exceeded the default local Node heap. A local production build was not completed. No booking, registration, trial, or payment was submitted.

## Current review captures

Fixtures use synthetic people/programs, placeholder imagery, and intercepted read-only responses while exercising production components. Only the Experts directory captures below use a live catalog read.

Latest profile captures supersede the earlier restored-expert layout screenshots:

| Surface                   | Desktop                                     | Mobile                                             |
| ------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Portrait and breadcrumb   | [Capture](offering-profile-desktop.png)     | [Capture](offering-profile-mobile.png)             |
| Shared curriculum preview | [Capture](offering-curriculum-desktop.png)  | [Capture](offering-curriculum-mobile.png)          |
| Calendar loading          | —                                           | [Capture](offering-calendar-loading-mobile.png)    |
| Consultation review       | —                                           | [Capture](offering-consultation-review-mobile.png) |
| Mentorship review         | [Capture](offering-subscription-review.png) | —                                                  |

| Surface                            | Desktop                                      | Mobile                                      |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Experts directory — original hero  | [Capture](restored-experts-desktop.png)      | [Capture](restored-experts-mobile.png)      |
| Programs directory — original hero | [Capture](restored-programs-desktop.png)     | [Capture](restored-programs-mobile.png)     |
| Expert profile — original card     | [Capture](restored-expert-desktop.png)       | [Capture](restored-expert-mobile.png)       |
| Class — original image hero        | [Capture](restored-class-desktop.png)        | [Capture](restored-class-mobile.png)        |
| Subscription — original heading    | [Capture](restored-subscription-desktop.png) | [Capture](restored-subscription-mobile.png) |
| Month availability loading         | [Capture](calendar-loading-desktop.png)      | [Capture](calendar-loading-mobile.png)      |
| Loaded month                       | —                                            | [Capture](calendar-loaded-mobile.png)       |

PDF previews: [Overview](curriculum-brochure-overview.png), [Curriculum](curriculum-brochure-content.png), [Continuation](curriculum-brochure-continuation.png), [Hindi overview](curriculum-brochure-hindi.png). [Download the synthetic sample](sample-curriculum.pdf).

## Earlier booking references

These captures predate the hero restoration. Their hero colors are superseded; unchanged booking flows remain useful references. The black-\* captures in this directory are also superseded iterations, not the current design.

| Surface              | Reference                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Consultation booking | [Desktop date/time](fixture-consultation-calendar-desktop.png), [Mobile review](fixture-consultation-review-mobile.png) |
| Mentorship review    | [Mobile](fixture-subscription-review-mobile.png)                                                                        |
| Webinar registration | [Mobile review](fixture-webinar-review-mobile.png)                                                                      |
| Appointment calendar | [Desktop](fixture-calendar-desktop.png), [Mobile](fixture-calendar-mobile.png)                                          |
| Pricing              | [Mobile](pricing-mobile.png)                                                                                            |
