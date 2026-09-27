import { redirect } from "next/navigation";

/** #1527 — requests are listed on Support; only each request has a page here. */
export default async function SupportRequestsIndex({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  redirect(`/dashboard/consultee/${consulteeId}/support`);
}
