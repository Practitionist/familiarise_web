import { AccountSettings } from "@/components/dashboard/account";

/** Settings › Account (#1527 §14) — the shared Account component. */
export default async function ConsulteeAccountSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  return (
    <AccountSettings
      returnHref={`/dashboard/consultee/${consulteeId}/settings/account`}
    />
  );
}
