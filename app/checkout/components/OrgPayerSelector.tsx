"use client";

import { useSession } from "@/lib/auth-client";
import { Building2, CreditCard } from "lucide-react";

interface OrgMembership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationLogo: string | null;
  organizationProfileId: string;
  kind: string;
  role: string;
  // Billing context fields populated by the session query in lib/auth.ts.
  // Used to render a cost-aware subtitle under each org option so the learner
  // knows whether selecting this org means "free", "draws from credits", or
  // "goes on the monthly invoice" before they confirm the booking.
  billingMode:     string | null;
  contractEndDate: string | null; // ISO string — Date is not serialisable over the wire
  creditBalance:   number | null; // paise; only meaningful for SEAT_PACK orgs
}

interface OrgPayerSelectorProps {
  selectedOrganizationId: string | null;
  onSelect: (organizationId: string | null) => void;
}

/**
 * Payer selector for checkout pages. Shows "Pay personally" vs
 * "Bill to [org name]" when the user has org memberships. Self-hides
 * for users with no org affiliations (B2C users).
 */
export function OrgPayerSelector({
  selectedOrganizationId,
  onSelect,
}: OrgPayerSelectorProps) {
  const { data: session } = useSession();
  const memberships = (session?.user?.organizationMemberships ?? []) as (OrgMembership & { billingMode?: string })[];

  if (memberships.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-zinc-700">Who is paying?</p>

      {/* Personal payment option */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
          selectedOrganizationId === null
            ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
            : "border-zinc-200 hover:border-zinc-300"
        }`}
      >
        <div className="w-8 h-8 rounded-md bg-zinc-100 flex items-center justify-center shrink-0">
          <CreditCard className="w-4 h-4 text-zinc-600" />
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-900">Pay with your card</p>
          <p className="text-xs text-zinc-500">Personal payment</p>
        </div>
      </button>

      {/* Org payment options */}
      {memberships.map((m) => {
        const isSelected = selectedOrganizationId === m.organizationId;
        return (
          <button
            key={m.organizationId}
            type="button"
            onClick={() => onSelect(m.organizationId)}
            className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
              isSelected
                ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
                : "border-zinc-200 hover:border-zinc-300"
            }`}
          >
            <div className="w-8 h-8 rounded-md bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0">
              {m.organizationLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={m.organizationLogo}
                  alt={m.organizationName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <Building2 className="w-4 h-4 text-zinc-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-900 truncate">
                Bill to {m.organizationName}
              </p>
              {/* Billing-aware subtitle. A learner in two orgs — one on
                  SEAT_PACK and one on PREPAID_UNLIMITED — needs to know
                  which option draws from a credit pool and which is free
                  before selecting. We derive this from billingMode,
                  creditBalance, and contractEndDate in the session payload
                  (see lib/auth.ts for where those fields are loaded). */}
              <p className="text-xs mt-0.5 truncate">
                {m.billingMode === "PREPAID_UNLIMITED" && (() => {
                  const expired = m.contractEndDate
                    ? new Date(m.contractEndDate) < new Date()
                    : false;
                  return expired
                    ? <span className="text-red-500">Contract expired — you will be charged personally</span>
                    : <span className="text-emerald-600">Free (org contract covers this)</span>;
                })()}
                {m.billingMode === "SEAT_PACK" && (
                  m.creditBalance !== null
                    ? <span className={m.creditBalance === 0 ? "text-red-500" : "text-zinc-500"}>
                        Credits: ₹{(m.creditBalance / 100).toLocaleString("en-IN")} remaining
                      </span>
                    : <span className="text-zinc-500">Credit pool</span>
                )}
                {m.billingMode === "INVOICED_MONTHLY" && (
                  <span className="text-zinc-500">Added to org&apos;s monthly invoice</span>
                )}
                {m.billingMode === "TAG_ONLY" && (
                  <span className="text-zinc-500">You pay — org receives the report</span>
                )}
                {!m.billingMode && (
                  <span className="text-zinc-500">Organisation billing</span>
                )}
              </p>
            </div>
          </button>
        );
      })}

      {selectedOrganizationId && (
        <p className="text-xs text-amber-600">
          Referral credits cannot be used for org-funded bookings.
        </p>
      )}
    </div>
  );
}
