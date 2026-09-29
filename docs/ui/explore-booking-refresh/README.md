# Explore and booking UI refresh

This is a presentation and booking-journey update against `dev`. No schema, availability engine, payment API, authentication policy, or deployment changes are included.

## Design decisions

| Decision               | Chosen direction                                                                          | Tradeoff                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Theme                  | Light Explore and pricing surfaces; retain existing dark tokens and unrelated dark routes | One consistent discovery experience, without a new app-wide theme switch                                 |
| Visual language        | Warm white, black primary actions, restrained lilac/peach/sky accents                     | More expressive than pure monochrome; accents do not replace semantic status colors                      |
| Discovery              | Curated content first, with a direct “Find” anchor to the catalog                         | Browsing comes first; filters remain one action away                                                     |
| Consultation booking   | Date and time together on desktop; Date → Time → Review on mobile                         | An explicit review adds a step before the existing checkout/approval action                              |
| Mentorship             | Start date → cycle review → existing checkout                                             | Makes the first-cycle boundary visible before payment                                                    |
| Mentorship price label | Total plan price, not “per month”                                                         | Matches the existing one-time `plan.price` checkout; no billing change or monthly-equivalent calculation |
| Group programs         | Registration review before the existing sign-in/checkout handoff                          | Adds confirmation while retaining capacity, event ids, cancellation disclosures, and callbacks           |
| Carousel               | Manual navigation                                                                         | Stable content while reading; viewing another featured item takes a click                                |

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
