import { redirect } from "next/navigation";
export default async function FeedbackPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  redirect(`/dashboard/consultee/${consulteeId}/support/feedback`);
}
