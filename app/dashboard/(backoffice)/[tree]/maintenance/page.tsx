import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import MaintenanceControls from "@/components/dashboard/MaintenanceControls";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeMaintenancePage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("maintenance.manage", (await params).tree);
  return (
    <>
      <DashboardHeader
        title="Maintenance Mode"
        subtitle="Control platform maintenance windows. Users see a warning banner (degraded) or a full maintenance page (offline)."
      />
      <DashboardContent>
        <MaintenanceControls />
      </DashboardContent>
    </>
  );
}
