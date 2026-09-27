import { requireBackofficePage } from "@/lib/auth-guard";
import { CompliancePageClient } from "./CompliancePageClient";

/** #1527 Q5 — personal-data obligations, admin only (`compliance.manage`). */
export default async function BackofficeCompliancePage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("compliance.manage", (await params).tree);
  return <CompliancePageClient />;
}
