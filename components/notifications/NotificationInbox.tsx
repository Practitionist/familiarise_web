"use client";

import { useMemo } from "react";
import { Inbox } from "@novu/nextjs";
import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";

const NOVU_APP_ID = process.env.NEXT_PUBLIC_NOVU_APP_ID;

type OrgMembershipLite = {
  organizationId: string;
  organizationName: string;
};

export function NotificationInbox() {
  const router = useRouter();
  const { data: session } = useSession();

  const memberships = useMemo(() => {
    const raw = (session?.user as Record<string, unknown> | undefined)
      ?.organizationMemberships;
    if (!Array.isArray(raw)) return [] as OrgMembershipLite[];
    // Validate rather than coerce. `String(someObject)` yields
    // "[object Object]", which would become a tab filter matching nothing and a
    // label rendering that literal — a malformed entry should drop out, not
    // produce a broken tab. (Also the SonarCloud finding on this block.)
    return raw.flatMap((m): OrgMembershipLite[] => {
      if (typeof m !== "object" || m === null) return [];
      const { organizationId, organizationName } = m as Record<string, unknown>;
      if (typeof organizationId !== "string" || organizationId === "") return [];
      return [
        {
          organizationId,
          organizationName:
            typeof organizationName === "string" && organizationName !== ""
              ? organizationName
              : "Organization",
        },
      ];
    });
  }, [session?.user]);

  /**
   * ADR 23 — one subscriber per user means every context shares a feed. Tabs
   * filter it back apart on the `scope` / `organizationId` the payloads now
   * carry.
   *
   * Only rendered for someone who actually belongs to an organization: a purely
   * B2C consultant has one context, and an "All / Personal" pair that always
   * shows the same list is noise. `scope` exists precisely so this filter can be
   * written — Novu matches payload fields by equality, and "organizationId is
   * null" is not expressible that way.
   */
  const tabs = useMemo(() => {
    if (memberships.length === 0) return undefined;
    return [
      { label: "All", filter: {} },
      { label: "Personal", filter: { data: { scope: "personal" } } },
      ...memberships.map((m) => ({
        label: m.organizationName,
        filter: { data: { organizationId: m.organizationId } },
      })),
    ];
  }, [memberships]);

  if (!session?.user?.id || !NOVU_APP_ID) {
    return null;
  }

  return (
    <Inbox
      applicationIdentifier={NOVU_APP_ID}
      subscriberId={session.user.id}
      tabs={tabs}
      placement="bottom-end"
      placementOffset={12}
      renderBell={(unreadCount) => {
        const count = unreadCount?.total ?? 0;
        return (
          <div
            role="status"
            className="relative inline-flex h-9 w-9 items-center justify-center"
            aria-label={`Notifications${count > 0 ? ` (${count} unread)` : ""}`}
          >
            <Bell className="h-5 w-5" />
            {count > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                {count > 99 ? "99+" : count}
              </span>
            )}
          </div>
        );
      }}
      onNotificationClick={(notification) => {
        const url = notification?.redirect?.url;
        if (url) {
          router.push(url);
        }
      }}
      appearance={{
        variables: {
          colorBackground: "#ffffff",
          colorForeground: "#18181b",
          colorPrimary: "#18181b",
          colorPrimaryForeground: "#ffffff",
          colorSecondary: "#f4f4f5",
          colorSecondaryForeground: "#3f3f46",
          colorCounter: "#ef4444",
          colorCounterForeground: "#ffffff",
          colorNeutral: "#a1a1aa",
          colorShadow: "rgba(0, 0, 0, 0.08)",
          fontSize: "0.875rem",
          borderRadius: "0.5rem",
        },
        elements: {
          popoverContent: {
            zIndex: 9999,
            width: "min(400px, calc(100vw - 2rem))",
            maxHeight: "calc(100vh - 6rem)",
            borderRadius: "0.75rem",
            boxShadow:
              "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
            border: "1px solid #e4e4e7",
            overflowY: "auto",
          },
          popoverTrigger: {
            zIndex: 9998,
          },
          bellContainer: {
            display: "contents",
          },
          notification: {
            padding: "12px 16px",
            gap: "12px",
          },
        },
      }}
    />
  );
}
