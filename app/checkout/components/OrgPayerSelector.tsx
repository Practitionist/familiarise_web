"use client";

import { useSession } from "@/lib/auth-client";
import Image from "next/image";
import { Building2, CreditCard } from "lucide-react";
import { FUNDING_SOURCE_LABEL } from "@/lib/labels/org-labels";

interface OrgPayerSelectorProps {
  selectedOrganizationId: string | null;
  onSelect: (organizationId: string | null) => void;
}

/**
 * Payer selector for checkout pages. Shows "Pay personally" vs "Bill to
 * [org name]" when the user has org memberships. Self-hides for users
 * with no org affiliations (B2C users).
 *
 * Each org option renders a funding-source-aware subtitle so the learner
 * knows what picking that org actually costs them before they confirm:
 *   - PERSONAL → "You pay — the org is tagged for reporting only"
 *   - WALLET   → "Credits: ₹X remaining"
 *   - INVOICE  → "Added to the org's monthly invoice"
 *   - LICENSE  → "Free — covered by the org's enterprise license"
 *
 * The membership shape comes straight from lib/auth.ts customSession;
 * there are no `as` casts here — the Session type already carries the
 * narrowed FundingSource via z.infer on the Prisma enum.
 */
export function OrgPayerSelector({
  selectedOrganizationId,
  onSelect,
}: OrgPayerSelectorProps) {
  const { data: session } = useSession();
  const memberships = session?.user?.organizationMemberships ?? [];

  // Only render the selector when the user has at least one org that can
  // actually sponsor (canSponsor=true). A pure HOST membership wouldn't
  // let the learner book through the org anyway, so showing it here
  // would be misleading.
  const sponsoringMemberships = memberships.filter((m) => m.canSponsor);
  if (sponsoringMemberships.length === 0) return null;

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
      {sponsoringMemberships.map((m) => {
        const isSelected = selectedOrganizationId === m.organizationId;
        const subtitle = renderSubtitle(m);
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
                <Image
                  src={m.organizationLogo}
                  alt={m.organizationName}
                  width={32}
                  height={32}
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
              <p className="text-xs mt-0.5 truncate">{subtitle}</p>
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

/**
 * Derive the cost-aware subtitle from the membership payload. Returns a
 * ReactNode because wallet + "no funding source" cases want coloured
 * numbers, while the rest are plain text.
 */
function renderSubtitle(m: {
  fundingSource: import("@prisma/client").FundingSource | null;
  walletBalance: number | null;
}): React.ReactNode {
  switch (m.fundingSource) {
    case "WALLET": {
      const paise = m.walletBalance ?? 0;
      return (
        <span className={paise === 0 ? "text-red-500" : "text-zinc-500"}>
          Credits: ₹{(paise / 100).toLocaleString("en-IN")} remaining
        </span>
      );
    }
    case "INVOICE":
      return (
        <span className="text-zinc-500">Added to org&apos;s monthly invoice</span>
      );
    case "LICENSE":
      return (
        <span className="text-emerald-600">
          Free — covered by enterprise license
        </span>
      );
    case "PERSONAL":
      return (
        <span className="text-zinc-500">You pay — org receives the report</span>
      );
    case "PROJECT":
      // v2 — not reachable through self-service yet.
      return (
        <span className="text-zinc-500">
          {FUNDING_SOURCE_LABEL.PROJECT} billing
        </span>
      );
    case null:
      // No billing account attached — org was set up without one, or it
      // was deleted. Default to a neutral label; server-side will reject
      // the org-funded checkout on validation.
      return <span className="text-zinc-500">Organization billing</span>;
  }
}
