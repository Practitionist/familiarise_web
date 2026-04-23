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

export const ORG_ERROR_COPY: Record<string, string> = {
  ORG_NOT_VERIFIED:
    "Your organization is awaiting platform review. This action will be available once a Familiarise admin verifies your account — this usually takes 1–2 business days.",
  ROLE_TRANSITION_BLOCKED:
    "Members cannot switch between Learner and Expert roles. Remove the member and re-invite them with the new role instead.",
  USER_NOT_FOUND:
    "No user account found with that email. They need to sign up at Familiarise first, or use the Invitations page to send them an invite.",
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
