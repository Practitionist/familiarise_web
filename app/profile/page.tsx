"use client";

import { useSession } from "next-auth/react";
import { ProfileInformation } from "./components/ProfileInformation";
import { AccountSettings } from "./components/AccountSettings";
import { CookiePreferences } from "./components/CookiePreferences";
import { NotificationPreferences } from "./components/NotificationPreferences";

export default function Profile() {
  const { data: session } = useSession();

  return (
    <div className="flex justify-center items-center min-h-screen px-4 py-20 md:py-30 lg:py-30 xl:py-40">
      <div className="max-w-4xl w-full space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <ProfileInformation session={session} />
          <AccountSettings session={session} />
        </div>
        <CookiePreferences />
        <NotificationPreferences />
      </div>
    </div>
  );
}
