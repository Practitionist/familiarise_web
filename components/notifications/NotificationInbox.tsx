"use client";

import { Inbox } from "@novu/nextjs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { useCounts } from "@novu/nextjs/hooks";

const NOVU_APP_ID = process.env.NEXT_PUBLIC_NOVU_APP_ID;

function NotificationBell() {
  const { counts } = useCounts({ filters: [{ read: false }] });
  const unreadCount = counts?.[0]?.count ?? 0;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative h-9 w-9"
      aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
    >
      <Bell className="h-5 w-5" />
      {unreadCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </Button>
  );
}

export function NotificationInbox() {
  const router = useRouter();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);

  if (!session?.user?.id || !NOVU_APP_ID) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div>
          <NotificationBell />
        </div>
      </PopoverTrigger>
      <PopoverContent
        className="w-[380px] p-0 max-h-[500px] overflow-hidden"
        align="end"
        sideOffset={8}
      >
        <Inbox
          applicationIdentifier={NOVU_APP_ID}
          subscriberId={session.user.id}
          onNotificationClick={(notification) => {
            const url = notification?.redirect?.url;
            if (url) {
              setOpen(false);
              router.push(url);
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
