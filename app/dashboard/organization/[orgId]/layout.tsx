"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Home,
  Users,
  Mail,
  GraduationCap,
  Briefcase,
  CreditCard,
  Coins,
  BarChart3,
  Settings,
  Wallet,
  UserCog,
  type LucideIcon,
} from "lucide-react";

import {
  CollapsibleSidebar,
  CollapsibleSidebarSkeleton,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { signOut, useSession } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";

interface OrgDetailsResponse {
  organization: { id: string; name: string; slug: string; logo: string | null };
  profile: {
    id: string;
    kind: "BUYER" | "PROVIDER" | "HYBRID";
    status: string;
    billingMode: "TAG_ONLY" | "SEAT_PACK" | "INVOICED_MONTHLY";
  };
  membership: { role: string; status: string };
}

async function fetchOrg(orgId: string): Promise<OrgDetailsResponse> {
  const res = await fetch(`/api/organizations/${orgId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load organization");
  }
  return res.json();
}

function AccessDenied({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <h2 className="text-xl font-bold text-zinc-900 mb-2">{title}</h2>
        <p className="text-zinc-600">{message}</p>
        <Link
          href="/dashboard/organization"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Back to organizations
        </Link>
      </motion.div>
    </div>
  );
}

export default function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending: isSessionLoading } = useSession();

  const {
    data: org,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => fetchOrg(orgId),
    enabled: !!orgId && !!session?.user?.id,
    staleTime: 60_000,
  });

  // Compute the sidebar items based on org kind, billing mode, AND role.
  // Lower roles see fewer nav items — the API layer enforces this too,
  // but hiding the pages prevents confusion.
  const sidebarItems: CollapsibleSidebarItem[] = useMemo(() => {
    if (!org) return [];
    const isProviderOrHybrid =
      org.profile.kind === "PROVIDER" || org.profile.kind === "HYBRID";
    const isBuyerOrHybrid =
      org.profile.kind === "BUYER" || org.profile.kind === "HYBRID";

    // Role rank check — mirrors ORG_ROLE_RANK from lib/auth-helpers.ts
    const role = org.membership.role;
    const RANKS: Record<string, number> = {
      ORG_OWNER: 100, ORG_ADMIN: 80, ORG_MANAGER: 60,
      ORG_CONSULTANT: 40, ORG_SUPPORT: 30, ORG_LEARNER: 20,
    };
    const isAtLeast = (min: string) =>
      (RANKS[role] ?? 0) >= (RANKS[min] ?? 0);

    const items: { name: string; icon: LucideIcon; path: string; show?: boolean }[] = [
      { name: "Overview", icon: Home, path: "home" },
      { name: "Members", icon: Users, path: "members" },
      { name: "Invitations", icon: Mail, path: "invitations", show: isAtLeast("ORG_ADMIN") },
      { name: "Learners", icon: GraduationCap, path: "learners", show: isBuyerOrHybrid },
      { name: "Consultants", icon: UserCog, path: "consultants", show: isProviderOrHybrid },
      { name: "Plans", icon: Briefcase, path: "plans" },
      {
        name: "Credits",
        icon: Coins,
        path: "credits",
        show: org.profile.billingMode === "SEAT_PACK" && isAtLeast("ORG_MANAGER"),
      },
      { name: "Billing", icon: CreditCard, path: "billing", show: isAtLeast("ORG_MANAGER") },
      {
        name: "Payouts",
        icon: Wallet,
        path: "payouts",
        show: isProviderOrHybrid,
      },
      { name: "Analytics", icon: BarChart3, path: "analytics", show: isAtLeast("ORG_MANAGER") },
      { name: "Settings", icon: Settings, path: "settings", show: isAtLeast("ORG_ADMIN") },
    ];

    return items
      .filter((it) => it.show !== false)
      .map(({ show: _show, ...rest }) => rest);
  }, [org]);

  // Redirect to /home when landing on the bare /[orgId] route.
  useEffect(() => {
    if (org && pathname === `/dashboard/organization/${orgId}`) {
      router.replace(`/dashboard/organization/${orgId}/home`);
    }
  }, [org, pathname, orgId, router]);

  const handleSignOut = async () => {
    try {
      await disconnectStreamClients();
    } catch {
      // ignore
    }
    signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/auth/signin";
        },
      },
    });
  };

  if (!session?.user?.id && !isSessionLoading) {
    return (
      <AccessDenied
        title="Authentication Required"
        message="Please sign in to access the organization dashboard."
      />
    );
  }

  if ((isLoading || isSessionLoading) && !org) {
    return <CollapsibleSidebarSkeleton />;
  }

  if (error) {
    return (
      <AccessDenied
        title="Organization unavailable"
        message={
          error instanceof Error
            ? error.message
            : "We could not load this organization."
        }
      />
    );
  }

  return (
    <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
      <CollapsibleSidebar
        items={sidebarItems}
        basePath={`/dashboard/organization/${orgId}`}
        title={org?.organization.name ?? "Organization"}
        avatarFallback={(org?.organization.name ?? "O").charAt(0).toUpperCase()}
        userName={org?.organization.name}
        userImage={org?.organization.logo}
        bottomUserChip={
          session?.user
            ? {
                name: session.user.name ?? null,
                image: session.user.image ?? null,
                role: org?.membership.role ?? "",
              }
            : undefined
        }
        pathname={pathname}
        onSignOut={handleSignOut}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="p-6">
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        </div>
      </main>
    </div>
  );
}
