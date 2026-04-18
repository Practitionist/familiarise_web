/**
 * @arch4-stub Pending Arch 4-Modified rewrite (Issue #681).
 *
 * The original prefetch helpers queried OrganizationProfile + related
 * credit-pool / org-invoice / etc. Under Arch 4-Modified the schema is:
 *
 *   - Organization (capability booleans, hierarchy, India fields)
 *   - BillingAccount (fundingSource: PERSONAL/LICENSE/WALLET/INVOICE)
 *   - Contract → Program → ProgramAssignment
 *   - WalletEntry (ledger)
 *
 * Every exported helper now returns `null` (safe fallback) so that HydrationBoundary
 * wrappers don't throw — the client hooks will re-fetch on mount.
 *
 * Live rewrite checklist lives at:
 *   docs/enterprise/phase-2-api-rewrite-checklist.md
 */

export interface OrgAnalytics {
  members: { total: number; learners: number };
  plans: { active: number };
  bookings: {
    monthToDate: number;
    lastMonth: number;
    deltaPct: number | null;
  };
  revenue: { monthToDateGross: number };
  seatsTotal: number | null;
  seatsUsed: number;
}

export interface OrgBilling {
  billingMode: string | null;
  currency: string;
  monthToDate: { gross: number; paymentCount: number };
  outstanding: { amount: number; invoiceCount: number };
  pendingCharges: { amount: number; paymentCount: number } | null;
  creditPool: { balance: number; totalPurchased: number } | null;
  orgInvoiceCreditLimit: number | null;
  paymentTermsDays: number;
}

export interface MemberRow {
  id: string;
  memberId: string;
  role: string;
  status: string;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

export async function prefetchOrgAnalytics(_orgId: string): Promise<OrgAnalytics | null> {
  return null;
}

export async function prefetchOrgBilling(_orgId: string): Promise<OrgBilling | null> {
  return null;
}

export async function prefetchOrgMembers(_orgId: string): Promise<MemberRow[] | null> {
  return null;
}

export async function prefetchOrgDetails(_orgId: string): Promise<unknown | null> {
  return null;
}

export async function prefetchOrgInvitations(_orgId: string): Promise<unknown | null> {
  return null;
}

export async function prefetchOrgCreditPool(_orgId: string): Promise<unknown | null> {
  return null;
}
