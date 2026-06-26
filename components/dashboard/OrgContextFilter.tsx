"use client";

/**
 * OrgContextFilter — a small client-side Select that lets a user who
 * belongs to one or more orgs slice their dashboard queries by org.
 *
 * Intended mount points:
 *   - /dashboard/consultant/[consultantId]/appointments
 *   - /dashboard/consultant/[consultantId]/payments
 *   - /dashboard/consultee/[consulteeId]/appointments
 *   - /dashboard/consultee/[consulteeId]/(features)/payments
 *
 * API contract: pages pass the selected filter to their backend query as
 * a `organizationId` query param (omit or set "__personal__" for personal-
 * only). Backend handlers are expected to filter `Payment.organizationId`
 * / `Appointment.organizationId` accordingly.
 *
 * Self-hides when the user belongs to zero orgs, so B2C-only users see no
 * additional chrome. Matches the self-hide logic on OrganizationSwitcher.
 */

import { useMemo } from "react";
import { Building2, User as UserIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/lib/auth-client";
import {
  ORG_FILTER_ALL,
  ORG_FILTER_PERSONAL,
  type OrgContextFilterValue,
} from "@/lib/dashboard/org-context-filter";

// Re-export for existing import sites (the pure helper lives in
// lib/dashboard/org-context-filter.ts so unit tests can import it
// without dragging the ESM-only auth-client chain through jest).
export {
  ORG_FILTER_ALL,
  ORG_FILTER_PERSONAL,
  type OrgContextFilterValue,
};

export function OrgContextFilter({
  value,
  onChange,
  className,
}: {
  value: OrgContextFilterValue;
  onChange: (next: OrgContextFilterValue) => void;
  className?: string;
}) {
  const { data: session } = useSession();
  const memberships = useMemo(
    () => session?.user?.organizationMemberships ?? [],
    [session?.user?.organizationMemberships],
  );

  // Zero memberships — this is a B2C-only user. Don't pollute their
  // dashboard with a useless filter.
  if (memberships.length === 0) return null;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className={`cursor-pointer ${className ?? "h-9 w-[220px]"}`}
      >
        <SelectValue placeholder="Filter by organization" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ORG_FILTER_ALL} className="cursor-pointer">
          <span className="inline-flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            All activity
          </span>
        </SelectItem>
        <SelectItem value={ORG_FILTER_PERSONAL} className="cursor-pointer">
          <span className="inline-flex items-center gap-2">
            <UserIcon className="h-4 w-4" />
            Personal only
          </span>
        </SelectItem>
        {memberships.map((m) => (
          <SelectItem
            key={m.organizationId}
            value={m.organizationId}
            className="cursor-pointer"
          >
            <span className="inline-flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              {m.organizationName}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

