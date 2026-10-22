import { redirect } from "next/navigation";
export default async function FeedbackPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  redirect(`/dashboard/consultant/${consultantId}/support/feedback`);
}
