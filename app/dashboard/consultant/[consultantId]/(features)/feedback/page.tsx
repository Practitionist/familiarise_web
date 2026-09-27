import { permanentRedirect } from "next/navigation";

/** Folded into Support requests (#1527); old links 308 to its Feedback tab. */
export default async function RetiredFeedbackPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(
    `/dashboard/consultant/${consultantId}/support?tab=feedback`,
  );
}
