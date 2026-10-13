/**
 * The Get-paid page's query key, in a module with no client directive and no
 * browser imports, because the server page seeds it and the client
 * reads it (#1675 PR-Y2; FAMILIARISE_WEB-5Q was the page importing this
 * through the client component and 500-ing on every load).
 */
export const payoutSetupQueryKey = (consultantId: string) =>
  ["consultant-payout-setup", consultantId] as const;
