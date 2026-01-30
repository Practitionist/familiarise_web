"use client";

import { NovuProvider as NovuSDKProvider } from "@novu/nextjs";
import { useSession } from "next-auth/react";

interface NovuProviderProps {
  children: React.ReactNode;
}

const NOVU_APP_ID = process.env.NEXT_PUBLIC_NOVU_APP_ID;

export default function NovuProvider({ children }: NovuProviderProps) {
  const { data: session } = useSession();

  // Only render Novu provider when user is authenticated and app ID is configured
  if (!session?.user?.id || !NOVU_APP_ID) {
    return <>{children}</>;
  }

  return (
    <NovuSDKProvider
      subscriberId={session.user.id}
      applicationIdentifier={NOVU_APP_ID}
    >
      {children}
    </NovuSDKProvider>
  );
}
