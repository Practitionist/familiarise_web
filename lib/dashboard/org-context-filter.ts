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

// The API query-param contract for the personal scope is the string
// "personal" (see `resolveOrgScope`). Pages map ORG_FILTER_PERSONAL →
// "personal" inline at the call site.
