import { AccountSettings } from "@/components/dashboard/account";
import { OwnerOnlySettingsNote } from "@/components/dashboard/OwnerOnlySettingsNote";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

/** Settings › Account (#1527 §14) — the shared Account component. */
export default async function ConsulteeAccountSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  const access = await requirePersonalProfileAccess("consultee", consulteeId);
  // The account form is the signed-in viewer's own; an operator never sees theirs here.
  if (access.isInspecting) {
    return <OwnerOnlySettingsNote title="Account" owner="learner" />;
  }
  return (
    <AccountSettings
      returnHref={`/dashboard/consultee/${consulteeId}/settings/account`}
    />
  );
}
