import { AccountSettings } from "@/components/dashboard/account";
import { OwnerOnlySettingsNote } from "@/components/dashboard/OwnerOnlySettingsNote";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

/** Settings › Account (#1527 §14) — the same component as the consultee's. */
export default async function ConsultantAccountSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  // The account form is the signed-in viewer's own; an operator never sees theirs here.
  if (access.isInspecting) {
    return <OwnerOnlySettingsNote title="Account" owner="expert" />;
  }
  return (
    <AccountSettings
      returnHref={`/dashboard/consultant/${consultantId}/settings/account`}
    />
  );
}
