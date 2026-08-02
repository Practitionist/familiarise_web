"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";

/**
 * Redirect page for /dashboard/admin
 * This page catches requests to /dashboard/admin (without subpath)
 * and redirects to /dashboard/admin/home
 */
export default function AdminDashboardRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/admin/home");
  }, [router]);

  return <HomeSkeleton />;
}
