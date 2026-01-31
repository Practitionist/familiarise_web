"use client";

import { Inbox } from "@novu/nextjs";
import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

const NOVU_APP_ID = process.env.NEXT_PUBLIC_NOVU_APP_ID;

export function NotificationInbox() {
  const router = useRouter();
  const { data: session } = useSession();

  if (!session?.user?.id || !NOVU_APP_ID) {
    return null;
  }

  return (
    <Inbox
      applicationIdentifier={NOVU_APP_ID}
      subscriberId={session.user.id}
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
            width: "400px",
            maxHeight: "480px",
            borderRadius: "0.75rem",
            boxShadow:
              "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
            border: "1px solid #e4e4e7",
            overflow: "visible",
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
