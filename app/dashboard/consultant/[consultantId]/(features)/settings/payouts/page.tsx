import { permanentRedirect } from "next/navigation";

export default async function PayoutsRedirectPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(`/dashboard/consultant/${consultantId}/settings/get-paid`);
}
