"use client";

import Image from "next/image";
import { Building2 } from "lucide-react";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";

interface OrgContextBarProps {
  orgName: string;
  orgLogo?: string | null;
  kind: "BUYER" | "PROVIDER" | "HYBRID";
  billingMode?:
    | "TAG_ONLY"
    | "SEAT_PACK"
    | "INVOICED_MONTHLY"
    | "PREPAID_UNLIMITED"
    | null;
  currentPage?: string;
}

const KIND_LABELS: Record<string, { label: string; className: string }> = {
  BUYER: { label: "Buyer", className: "bg-blue-100 text-blue-700" },
  PROVIDER: {
    label: "Provider",
    className: "bg-emerald-100 text-emerald-700",
  },
  HYBRID: { label: "Hybrid", className: "bg-purple-100 text-purple-700" },
};

const BILLING_LABELS: Record<string, { label: string; className: string }> = {
  TAG_ONLY: { label: "Tag Only", className: "bg-zinc-100 text-zinc-600" },
  SEAT_PACK: { label: "Seat Pack", className: "bg-amber-100 text-amber-700" },
  INVOICED_MONTHLY: {
    label: "Invoiced",
    className: "bg-orange-100 text-orange-700",
  },
  PREPAID_UNLIMITED: {
    label: "Prepaid",
    className: "bg-green-100 text-green-700",
  },
};

/**
 * Sticky info strip at the top of every org dashboard page.
 *
 * Responsibility: orientation (which org, what kind, which page) and billing
 * context (kind + billing mode badges). Context-switching (personal dashboard,
 * other orgs, sign out) lives in the sidebar's bottomUserChip dropdown instead
 * so all navigation is in one discoverable place.
 *
 * Desktop (md+): org logo icon + badges + page name. Org name text is hidden
 * because the sidebar header already shows it — no duplication.
 * Mobile: org name text is shown because the sidebar is hidden.
 */
export function OrgContextBar({
  orgName,
  orgLogo,
  kind,
  billingMode,
  currentPage,
}: OrgContextBarProps) {
  const kindBadge = KIND_LABELS[kind];
  const billingBadge = billingMode ? BILLING_LABELS[billingMode] : null;

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2 bg-white border-b border-zinc-200 text-sm min-w-0">
      {/* Org identity — logo always visible; name text hidden on desktop since
          the sidebar header already shows it there. Shown on mobile where the
          sidebar is collapsed out of view. */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-6 h-6 rounded-md bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0">
          {orgLogo ? (
            <Image
              src={orgLogo}
              alt={orgName}
              width={24}
              height={24}
              className="object-cover"
            />
          ) : (
            <Building2 className="w-3.5 h-3.5 text-zinc-500" />
          )}
        </div>
        <span className="md:hidden font-medium text-zinc-800 truncate">
          {orgName}
        </span>
      </div>

      {/* Kind + billing badges — the only place these are shown; they aren't
          visible anywhere in the sidebar or page headers. */}
      <div className="flex items-center gap-1.5 shrink-0">
        {kindBadge && (
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-medium ${kindBadge.className}`}
          >
            {kindBadge.label}
          </span>
        )}
        {billingBadge && (
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-medium ${billingBadge.className}`}
          >
            {billingBadge.label}
          </span>
        )}
      </div>

      {/* Current page breadcrumb — matches the page's own heading */}
      {currentPage && (
        <>
          <span className="text-zinc-300 select-none shrink-0">/</span>
          <span className="text-zinc-600 font-medium truncate">{currentPage}</span>
        </>
      )}

      {/* Right-side actions */}
      <div className="flex-1" />
      {/* TODO: Subscribe this inbox to org-scoped Novu topics (e.g.
          `org-${orgId}`) once enterprise notification events are wired up.
          Currently shows the user's global inbox — same as the personal
          dashboard bell. Tracked in GitHub issue: feat(enterprise): wire
          Novu notifications for org lifecycle events */}
      <NotificationInbox />
    </div>
  );
}
