import { permanentRedirect } from "next/navigation";

/** Folded into Support requests (#1527); old links 308 to its Feedback tab. */
export default async function RetiredFeedbackPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  permanentRedirect(`/dashboard/consultee/${consulteeId}/support?tab=feedback`);
}
