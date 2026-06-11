/**
 * Pure helper + sentinel constants for the OrgContextFilter dashboard
 * component. Extracted from the React module so unit tests can import
 * without dragging in the ESM-only auth-client chain.
 *
 * The component (`components/dashboard/OrgContextFilter.tsx`) re-exports
 * these values so existing callers keep their imports. The filter
 * sentinel → API query-param contract lives here.
 */

/**
 * Sentinel value for "the caller's own data, not tied to any org".
 *
 * Renamed from "__personal__" → "mine" in the #768 lockdown (#674
 * closure) so the URL contract matches resolveOrgScope (which also
 * accepts "mine"). The double-underscore prefix added URL noise without
 * carrying meaning.
 */
export const ORG_FILTER_PERSONAL = "mine";
/** Sentinel value for "all — don't filter". */
export const ORG_FILTER_ALL = "all";

export type OrgContextFilterValue =
  | typeof ORG_FILTER_ALL
  | typeof ORG_FILTER_PERSONAL
  | string; // an organizationId
