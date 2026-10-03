import type { ReactNode } from "react";
import BackofficeLayout from "@/app/dashboard/(backoffice)/[tree]/layout";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function AdminReferralCreditsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  await requireBackofficePage("referrals.read", "admin");
  return (
    <BackofficeLayout params={Promise.resolve({ tree: "admin" })}>
      {children}
    </BackofficeLayout>
  );
}
