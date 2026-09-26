import { permanentRedirect } from "next/navigation";

/** Folded into Help & support (#1527 Q2); old links 308 to its help tab. */
export default async function RetiredHelpPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(`/dashboard/consultant/${consultantId}/support?tab=help`);
}
