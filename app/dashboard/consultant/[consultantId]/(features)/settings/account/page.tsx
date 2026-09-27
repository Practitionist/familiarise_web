import { AccountSettings } from "@/components/dashboard/account";

/** Settings › Account (#1527 §14) — the same component as the consultee's. */
export default async function ConsultantAccountSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  return (
    <AccountSettings
      returnHref={`/dashboard/consultant/${consultantId}/settings/account`}
    />
  );
}
