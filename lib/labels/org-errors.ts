/**
 * User-facing copy for organization-lifecycle API error codes.
 *
 * Some org routes return a machine-readable code in the `error` field
 * (e.g. `ORG_NOT_VERIFIED` from `requireOrgAccess` when an org is still
 * PENDING_VERIFICATION). The dashboard surfaces these codes in toasts,
 * dialogs, and inline form errors, so we need one place that maps code
 * → sentence.
 *
 * This sits next to `org-labels.ts` rather than under `lib/errors/`
 * because it mirrors the label-table pattern (`MEMBER_ROLE_LABEL`,
 * `FUNDING_SOURCE_LABEL`) — one record per enum-like vocabulary. The
 * `lib/errors/` tree is reserved for the payment classification +
 * toast-dispatch machinery, which is keyed on `errorType` (a different
 * axis) and lives on the billing/booking path.
 *
 * Adding a new code: append to `ORG_ERROR_COPY`, then emit it from the
 * server handler. Unknown codes fall through `humanizeOrgError` to the
 * raw message so genuine free-form errors still render.
 */
import { SUPPORT_EMAIL } from "@/lib/company";

export const ORG_ERROR_COPY: Record<string, string> = {
  ORG_NOT_VERIFIED:
    "Your organisation is awaiting review. This will be available once our team verifies your account, which usually takes 1–2 business days.",
  ROLE_TRANSITION_BLOCKED:
    "Members can't switch between Learner and Expert roles. Remove the member and invite them again with the new role.",
  USER_NOT_FOUND:
    "We couldn't find an account with that email. They need to sign up at Familiarise first, or you can send them an invitation from the Invitations page.",
  EXPERT_REQUIRES_CANHOST:
    "Experts can only be added to organisations that host sessions. Turn on hosting under Settings → Capabilities first.",
  // Why: #729 strict acceptance criterion #5. Adding a user as Expert
  // is a roster-membership action, not an identity-grant — the target
  // must already have opted into being a consultant on Familiarise.
  // Previously the route lazy-created a ConsultantProfile for any
  // user added as Expert, which silently promoted strangers to
  // consultants. The dashboard now refuses with this message.
  NOT_A_CONSULTANT:
    "This account has no expert profile yet. Set one up first, which takes a few minutes, then accept the invitation again.",
  // Symmetric to NOT_A_CONSULTANT — the org dashboard refuses to
  // lazy-create a ConsulteeProfile for a stranger being added as
  // Learner. The target must already have a consumer-side identity on
  // Familiarise (most users do by default, but consultant-only or SSO-
  // provisioned accounts may not).
  NOT_A_CONSULTEE:
    "This person doesn't have a learner profile on Familiarise yet. They need to sign up or finish setting up their account before they can be added as a Learner.",
  LEARNER_REQUIRES_CANSPONSOR:
    "Learners can only be added to organisations that sponsor sessions. Turn on sponsorship under Settings → Capabilities first.",
  // Why: PO balance enforcement (docs/finance/50-b2b/04-invoices-purchase-orders-and-dunning.md).
  // The server emits EXCEEDED; the INSUFFICIENT alias exists so route renames don't break the UI copy.
  PO_BALANCE_EXCEEDED:
    "This purchase order doesn't have enough remaining budget for the invoice. Reduce the invoice total or add a new PO.",
  PO_BALANCE_INSUFFICIENT:
    "This purchase order doesn't have enough remaining budget for the invoice. Reduce the invoice total or add a new PO.",
  // Why: domain-claim gates on SSO provider registration. Operators
  // pasting the wrong corporate domain saw a 422 with no actionable
  // copy; these strings point them at the exact recovery flow.
  DOMAIN_NOT_OWNED:
    "Your organisation hasn't added this email domain yet. Add it under Settings → SSO → Domains and verify it before setting up a sign-in provider.",
  DOMAIN_NOT_VERIFIED:
    "This domain still needs to be verified. Add the verification record shown under Settings → SSO → Domains at your domain provider, then choose Verify.",
  // Why: surfaced on the SSO settings page when a provider's stored config
  // cannot be read; we want operators (not end users) to know to re-enter it.
  SSO_PROVIDER_MISCONFIGURED:
    "We couldn't read your sign-in provider's settings. Delete and re-add the provider, or ask your IT admin for help.",
  // Why: hard-gate replacing the WIP banner on `canHost`. The friendly
  // copy points operators at the recovery path (talk to ops) rather
  // than leaving them stranded with a generic 400.
  // #1298 — static NEXT_PUBLIC read: this table ships to client components.
  HOST_ORGS_GATED: `Hosting sessions isn't available for your organisation yet. Please contact us at ${SUPPORT_EMAIL} to switch it on.`,
};

/**
 * Translate a server-provided error string into user-facing copy.
 * If the string matches a known code, returns the mapped sentence.
 * Otherwise returns the input unchanged, so free-form server messages
 * (e.g. validation feedback) still reach the user verbatim.
 */
export function humanizeOrgError(message: string): string {
  return ORG_ERROR_COPY[message] ?? message;
}
