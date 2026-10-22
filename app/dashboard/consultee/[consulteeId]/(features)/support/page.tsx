import { PersonalSupportRequests } from "@/app/support/_components/PersonalSupportRequests";
export default async function SupportPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  return <PersonalSupportRequests tree="consultee" profileId={consulteeId} />;
}
