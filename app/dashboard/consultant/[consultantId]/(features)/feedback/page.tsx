import { permanentRedirect } from "next/navigation";

/** Folded into Help & support (#1527 Q2); old links 308 to its feedback tab. */
export default async function RetiredFeedbackPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(
    `/dashboard/consultant/${consultantId}/support?tab=feedback`,
  );
}
