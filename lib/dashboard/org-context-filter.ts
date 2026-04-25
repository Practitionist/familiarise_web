/**
 * Pure helper + sentinel constants for the OrgContextFilter dashboard
 * component. Extracted from the React module so unit tests can import
 * without dragging in the ESM-only auth-client chain.
 *
 * The component (`components/dashboard/OrgContextFilter.tsx`) re-exports
 * these values so existing callers keep their imports. The filter
 * sentinel → API query-param contract lives here.
 */

/** Sentinel value for "personal / solo bookings only" (no organizationId). */
export const ORG_FILTER_PERSONAL = "__personal__";
/** Sentinel value for "all — don't filter". */
export const ORG_FILTER_ALL = "__all__";

export type OrgContextFilterValue =
  | typeof ORG_FILTER_ALL
  | typeof ORG_FILTER_PERSONAL
  | string; // an organizationId

/**
 * Translate a filter sentinel to the query-param representation expected
 * by the API. Returns `undefined` when no filter should be sent.
 *
 *   ORG_FILTER_ALL       → undefined   (no filter)
 *   ORG_FILTER_PERSONAL  → "none"      (API interprets as: organizationId IS NULL)
 *   <orgId>              → <orgId>     (API filters rows where organizationId = <orgId>)
 */
export function serializeOrgFilter(
  value: OrgContextFilterValue,
): string | undefined {
  if (value === ORG_FILTER_ALL) return undefined;
  if (value === ORG_FILTER_PERSONAL) return "none";
  return value;
}
