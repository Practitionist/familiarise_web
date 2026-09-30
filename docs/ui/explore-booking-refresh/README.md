# Explore and booking UI refresh

This is a presentation and booking-journey update against `dev`. No schema, availability engine, payment API, authentication policy, or deployment changes are included.

## Design decisions

| Decision               | Chosen direction                                                                                         | Tradeoff                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Theme                  | Enterprise-style charcoal Explore heroes, with light content and booking surfaces; pricing remains light | Stronger dark/light separation without introducing an app-wide dark-mode switch                          |
| Visual language        | White hero headings/actions, neutral gray supporting text, warm-white content and restrained accents     | Keeps the refreshed layouts rather than restoring the older designs; semantic status colors stay intact  |
| Discovery              | Curated content first, with a direct “Find” anchor to the catalog                                        | Browsing comes first; filters remain one action away                                                     |
| Consultation booking   | Date and time together on desktop; Date → Time → Review on mobile                                        | An explicit review adds a step before the existing checkout/approval action                              |
| Mentorship             | Start date → cycle review → existing checkout                                                            | Makes the first-cycle boundary visible before payment                                                    |
| Mentorship price label | Total plan price, not “per month”                                                                        | Matches the existing one-time `plan.price` checkout; no billing change or monthly-equivalent calculation |
| Group programs         | Registration review before the existing sign-in/checkout handoff                                         | Adds confirmation while retaining capacity, event ids, cancellation disclosures, and callbacks           |
| Carousel               | Manual navigation                                                                                        | Stable content while reading; viewing another featured item takes a click                                |

## Scope

- Expert and program directories, cards, filters, loading states, and expert quick-view styling.
- Expert profiles and all four plan-detail types: consultations, subscriptions, classes, and webinars.
- Responsive pricing segments, guided booking dialogs, mobile booking actions, timezone labels, and selection/focus persistence.
- Shared calendar shells, date-cell accessibility, appointment-day expansion, and planner price/currency fields.
- Booking dialogs clear the fixed navigation stack. Refreshed, missing, expired, or loading availability cannot be submitted as a stale selection. Allocation changes use the current window's approval policy.

## Verification

- 20 targeted Jest suites, 128 tests passing. Coverage includes duplicate-duration plan selection, stale/removed windows, refresh loading, allocation changes, paused request-only experts, start-date review, service-tab remounts, focus restoration, guest callbacks, event ids, sold-out states, and scheduling/status regressions.
- ESLint passes for changed and newly added TypeScript sources/tests.
- Focused TypeScript check covers changed roots, ambient declarations, and their transitive imports. The full-project check exceeded the default Node heap locally; this is not represented as a full-project type-check pass.
- `git diff --check` passes.
- Browser verification uses 1440px desktop and 390px mobile viewports with reduced motion, plus 768px tablet checks for class/webinar details. No page exceptions were observed; the final capture pass also has no console errors. No booking, registration, trial, or payment submission was made.

Browser checks cover consultation date/time selection → review → Back, mentorship start date → review → Back, program-type filters, registration review/Back for classes and webinars, all four detail-page types, month-calendar session expansion, and narrow-viewport overflow. Unit tests exercise allocation changes, request-only/paused experts, duplicate-duration plans, capacity states, and authenticated/guest checkout handoffs.

The live expert-detail route encountered database connection timeouts. Isolated, read-only fixture responses were used for the remaining UI verification; this does not verify production availability or payment integrations. The temporary preview route is removed before committing.

## Review screenshots

Fixtures use synthetic people/programs, placeholder imagery, and intercepted read-only API responses. They exercise the production components, not a separate mockup. Counts in the live expert-directory capture are actual catalog data from that read; counts in fixture captures are fixture values.

### Current charcoal heroes

The follow-up replaces the lilac Explore hero treatments with the enterprise hero's `zinc-950` background. Local hero tokens also invert badges, borders, and actions; they do not darken the content cards or booking dialogs. Pricing's existing hero is not changed by this follow-up.

These are isolated production-header previews, not full directory/detail-page integration captures. The subscription preview renders the full production subscription component. Desktop is 1440px and mobile is 390px. Browser checks verify heading/supporting-text contrast, light content cards, no horizontal overflow, and a keyboard-accessible primary link with visible focus. Nine discovery/booking suites (35 tests), ESLint, formatting, and a focused TypeScript check also pass for the follow-up.

| Header         | Desktop                                   | Mobile                                   |
| -------------- | ----------------------------------------- | ---------------------------------------- |
| Experts        | [Capture](black-experts-desktop.png)      | [Capture](black-experts-mobile.png)      |
| Programs       | [Capture](black-programs-desktop.png)     | [Capture](black-programs-mobile.png)     |
| Expert profile | [Capture](black-expert-desktop.png)       | [Capture](black-expert-mobile.png)       |
| Group program  | [Capture](black-class-desktop.png)        | [Capture](black-class-mobile.png)        |
| Subscription   | [Capture](black-subscription-desktop.png) | [Capture](black-subscription-mobile.png) |

### Initial iteration and booking references

The captures below predate the charcoal-hero revision. Their hero colors are superseded by the current previews above; the unchanged booking/calendar flows remain useful references.

| Surface              | Desktop                                                | Mobile                                            | Data                    |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------- | ----------------------- |
| Expert directory     | [Capture](experts-desktop.png)                         | [Capture](experts-mobile.png)                     | Live read               |
| Program directory    | [Capture](fixture-programs-desktop.png)                | [Capture](fixture-programs-mobile.png)            | Fixtures                |
| Expert profile       | [Capture](fixture-expert-desktop.png)                  | —                                                 | Fixtures                |
| Consultation booking | [Date/time](fixture-consultation-calendar-desktop.png) | [Review](fixture-consultation-review-mobile.png)  | Fixtures                |
| Mentorship review    | —                                                      | [Capture](fixture-subscription-review-mobile.png) | Fixtures                |
| Class details        | [Capture](fixture-class-detail-desktop.png)            | [Capture](fixture-class-detail-mobile.png)        | Fixtures                |
| Webinar registration | —                                                      | [Review](fixture-webinar-review-mobile.png)       | Fixtures                |
| Appointment calendar | [Capture](fixture-calendar-desktop.png)                | [Capture](fixture-calendar-mobile.png)            | Fixtures                |
| Pricing page         | —                                                      | [Capture](pricing-mobile.png)                     | Existing static content |

Live detail-page integration and a production build remain follow-up verification for an environment with a working database and sufficient build memory. No before/after equivalence or end-to-end payment result is claimed by these screenshots.

## Curriculum PDF decision (not implemented)

The subscription page currently renders `subscriptionContents` as its roadmap. It does not render attached `PlanMaterial` files. The existing materials-management API is authenticated and owner/org-management scoped, and the material model has no public-brochure designation. A PDF attachment must not automatically become public just because it is a PDF.

Recommended follow-up: explicitly public curriculum brochures alongside a short accessible on-page summary. Show a labelled “View curriculum brochure (PDF)” card with filename/size and open it in a new tab; avoid an embedded PDF viewer on mobile. If only the PDF exists, the card replaces the absent roadmap; if both exist, keep the roadmap and show the brochure beneath it; if neither exists, omit the empty section. Do not claim a PDF is available before an actual public brochure is configured.

Choice to confirm: public brochure + summary (better pre-booking evaluation, requires explicit upload/visibility support), learner-only PDF (protects curriculum, less information before booking), or a separate brochure PR (keeps this UI iteration focused). Existing learner materials are not newly exposed by this PR.
