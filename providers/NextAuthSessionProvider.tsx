"use client";
import { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";

interface Props {
  children: React.ReactNode;
  session: Session | null;
}

export default function NextAuthProvider({
  children,
  session,
}: Readonly<Props>) {
  return (
    <SessionProvider
      session={session}
      // PERFORMANCE FIX: Reduce session refetch frequency
      // Default behavior causes excessive /api/auth/session calls
      refetchInterval={5 * 60} // Refetch every 5 minutes instead of default
      refetchOnWindowFocus={false} // Don't refetch on window focus
    >
      {children}
    </SessionProvider>
  );
}
