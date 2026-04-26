"use client";

import Link from "next/link";
import Image from "next/image";
import { Building2, Plus, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/auth-client";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  MEMBER_ROLE_LABEL,
} from "@/lib/labels/org-labels";

/**
 * OrgSwitcher dropdown rendered in the consultant/consultee navbar and
 * the admin/staff layouts. Reads `session.user.organizationMemberships`
 * populated by the customSession callback in lib/auth.ts.
 *
 * Self-hides for users with no org memberships so the navbar layout
 * stays unchanged for B2C users. Each org row shows a capability label
 * (Sponsor / Host / Hybrid) and the user's role label, both resolved
 * through lib/labels/org-labels.ts so the two badges stay consistent
 * with the context bar.
 */
export function OrganizationSwitcher() {
  const { data: session } = useSession();
  const memberships = session?.user?.organizationMemberships ?? [];
  const isOrgAdmin = session?.user?.role === "ORG_ADMIN";

  // ORG_ADMIN users always see the switcher (they need "Create or manage"
  // access). Other roles only see it when they have at least one org.
  if (memberships.length === 0 && !isOrgAdmin) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-2 text-zinc-700 hover:text-zinc-900"
        >
          <Building2 className="h-4 w-4" />
          <span className="hidden sm:inline">
            {memberships.length === 1
              ? memberships[0].organizationName
              : `${memberships.length} organizations`}
          </span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.map((m) => {
          const capability = deriveCapabilityKind(m.canSponsor, m.canHost);
          return (
            <DropdownMenuItem key={m.organizationId} asChild>
              <Link
                href={`/dashboard/organization/${m.organizationId}/home`}
                className="flex items-center gap-3 cursor-pointer"
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
                    {m.organizationName}
                  </p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Badge
                      variant="secondary"
                      className={`text-[10px] h-4 px-1 ${CAPABILITY_BADGE_CLASS[capability]}`}
                    >
                      {CAPABILITY_LABEL[capability]}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] h-4 px-1">
                      {MEMBER_ROLE_LABEL[m.role]}
                    </Badge>
                  </div>
                </div>
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href="/dashboard/organization"
            className="flex items-center gap-2 cursor-pointer text-sm text-zinc-700"
          >
            <Plus className="h-4 w-4" />
            Create or manage organizations
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
