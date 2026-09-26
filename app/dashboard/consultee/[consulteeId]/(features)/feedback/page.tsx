import { permanentRedirect } from "next/navigation";

/** Folded into Help & support (#1527 Q2); old links 308 to its feedback tab. */
export default async function RetiredFeedbackPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  permanentRedirect(`/dashboard/consultee/${consulteeId}/support?tab=feedback`);
}
