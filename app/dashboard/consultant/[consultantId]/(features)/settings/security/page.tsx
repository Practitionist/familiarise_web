import { permanentRedirect } from "next/navigation";

/** Security folded into Settings › Account (#1527 §14); old links 308 there. */
export default async function SecuritySettingsRedirect({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(`/dashboard/consultant/${consultantId}/settings/account`);
}
