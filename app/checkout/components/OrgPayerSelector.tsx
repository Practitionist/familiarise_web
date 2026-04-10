"use client";

import { useSession } from "@/lib/auth-client";
import { Building2, CreditCard, Coins, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface OrgMembership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationLogo: string | null;
  organizationProfileId: string;
  kind: string;
  role: string;
}

interface OrgPayerSelectorProps {
  selectedOrganizationId: string | null;
  onSelect: (organizationId: string | null) => void;
}

const BILLING_MODE_LABELS: Record<string, { label: string; icon: typeof CreditCard; description: string }> = {
  TAG_ONLY: {
    label: "Tag-only",
    icon: CreditCard,
    description: "You pay now; tagged to org for reporting",
  },
  SEAT_PACK: {
    label: "Credits",
    icon: Coins,
    description: "Deducted from org credit pool",
  },
  INVOICED_MONTHLY: {
    label: "Invoiced",
    icon: Receipt,
    description: "Added to org's next invoice",
  },
};

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
        // billingMode is not on the session membership type — we'll show
        // the org name and let the backend handle billing mode routing.
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
              <div className="flex items-center gap-1.5 mt-0.5">
                <Badge variant="outline" className="text-[10px] h-4 px-1">
                  {m.kind}
                </Badge>
                <Badge variant="secondary" className="text-[10px] h-4 px-1">
                  {m.role.replace("ORG_", "")}
                </Badge>
              </div>
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
