"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Building2, ChevronRight } from "lucide-react";
import type { FundingSource } from "@prisma/client";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
} from "@/lib/labels/org-labels";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";

interface OrgContextBarProps {
  orgName: string;
  orgLogo?: string | null;
  canSponsor: boolean;
  canHost: boolean;
  fundingSource?: FundingSource | null;
  /**
   * Ordered breadcrumb segments from root to current page.
   * The last entry is highlighted as the active page.
   * Example: ["Settings", "SSO", "Providers"]
   */
  breadcrumbs?: string[];
  /**
   * Link back to the user's personal dashboard. When provided, renders a
   * prominent "← Personal" affordance at the far left of the bar. Hidden
   * when null/undefined.
   */
  personalHref?: string | null;
}

/**
 * Sticky info strip at the top of every org dashboard page.
 *
 * Responsibility: orientation (which org, what capability, which page) and
 * funding context (capability + funding-source badges). Context-switching
 * (personal dashboard, other orgs, sign out) lives in the sidebar's
 * bottomUserChip dropdown so all navigation is in one discoverable place.
 *
 * Desktop (md+): org logo icon + badges + page name. Org name text is
 * hidden because the sidebar header already shows it — no duplication.
 * Mobile: org name text is shown because the sidebar is hidden.
 *
 * Label resolution runs through lib/labels/org-labels.ts so every surface
 * that renders capability/funding badges uses the same string + colour
 * pair. Previously inline maps in this file drifted out of sync with the
 * org-list and org-switcher, which is why they now all import from the
 * shared util.
 */
export function OrgContextBar({
  orgName,
  orgLogo,
  canSponsor,
  canHost,
  fundingSource,
  breadcrumbs = [],
  personalHref,
}: OrgContextBarProps) {
  const capability = deriveCapabilityKind(canSponsor, canHost);
  const capabilityLabel = CAPABILITY_LABEL[capability];
  const capabilityClass = CAPABILITY_BADGE_CLASS[capability];
  const fundingLabel = fundingSource ? FUNDING_SOURCE_LABEL[fundingSource] : null;
  const fundingClass = fundingSource ? FUNDING_SOURCE_BADGE_CLASS[fundingSource] : null;

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 h-14 px-4 bg-white border-b border-zinc-200 text-sm min-w-0">
      {/* Back-link to personal dashboard — primary "escape" affordance so
          users don't get stuck in org context. Divider visually separates
          "escape" from "current org identity". */}
      {personalHref && (
        <Link
          href={personalHref}
          className="text-xs text-zinc-500 hover:text-zinc-900 flex items-center gap-1 shrink-0 border-r border-zinc-200 pr-3 mr-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Personal
        </Link>
      )}

      {/* Org identity — logo always visible; name text hidden on desktop
          since the sidebar header already shows it there. Shown on mobile
          where the sidebar is collapsed out of view. */}
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

      {/* Capability + funding-source badges. These are the only place they
          render in the dashboard chrome — neither the sidebar nor page
          headers surface them, so this bar is the canonical "what am I
          looking at" indicator. */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${capabilityClass}`}
        >
          {capabilityLabel}
        </span>
        {fundingLabel && fundingClass && (
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-medium ${fundingClass}`}
          >
            {fundingLabel}
          </span>
        )}
      </div>

      {/* Breadcrumbs — chevron-separated path, last segment highlighted
          as the active page. Forward-compatible with multi-level nested
          routes (e.g. Settings > SSO > Providers > Add). */}
      {breadcrumbs.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1 min-w-0 shrink"
        >
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <span key={i} className="flex items-center gap-1 min-w-0">
                <ChevronRight className="h-3.5 w-3.5 text-zinc-300 shrink-0" />
                <span
                  className={
                    isLast
                      ? "text-zinc-900 font-semibold truncate"
                      : "text-zinc-500 truncate"
                  }
                  aria-current={isLast ? "page" : undefined}
                >
                  {crumb}
                </span>
              </span>
            );
          })}
        </nav>
      )}

      {/* Right-side actions */}
      <div className="flex-1" />
      {/* Future: subscribe this inbox to org-scoped Novu topics (e.g.
          `org-${orgId}`) once enterprise notification events are wired up.
          Currently shows the user's global inbox — same as the personal
          dashboard bell. */}
      <NotificationInbox />
    </div>
  );
}
