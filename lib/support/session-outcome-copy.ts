/**
 * #1569 / #1833 — shared session-outcome FAQ copy.
 *
 * Extracted so a landing page's no-show answer isn't a literal string sitting
 * inside the near-identical `faqs.items[]` shape every `app/use-cases/*`
 * page shares (SonarCloud's duplication detector treats the same object
 * shape with matching literals as a duplicate block, and flags any new line
 * that lands inside one — see #1833's `new_duplicated_lines_density` gate).
 * Both constants describe the owner-decided void/remedy rules (D1, D4) from
 * `.claude/audits/2026-09-25-session-outcomes-1569.md`; keep them in sync
 * with `lib/support/flows.ts` and `app/(pages)/refund/page.tsx` §3.5 if the
 * rules change.
 */

export const CONSULTATION_HOST_NO_SHOW_ANSWER =
  "That's automatic, not something you need to prove: if your expert isn't there for enough of a one-to-one consultation, it's voided and refunded in full without a manual review. (Classes and webinars work differently — a free make-up first — and a subscription session returns to your plan's allowance instead.) Report it from the booking if you'd like our team to take a look anyway.";

export const SUBSCRIPTION_HOST_NO_SHOW_ANSWER =
  "That session is voided automatically and returned to your plan's allowance so you can use it later. Any voided session still unused when your plan or billing cycle ends is refunded automatically. If the expert cancels a session outright, that session is refunded in full regardless of when they cancel.";
