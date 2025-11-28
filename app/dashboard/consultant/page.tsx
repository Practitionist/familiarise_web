"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Redirect page for incomplete consultant dashboard URL
 * This page catches requests to /dashboard/consultant (without ID)
 * and redirects to /dashboard which handles role-based routing
 */
export default function ConsultantDashboardRedirect() {
  const router = useRouter();

  useEffect(() => {
    // Redirect to generic dashboard which will route to the correct consultant dashboard
    router.replace("/dashboard");
  }, [router]);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
    </div>
  );
}
