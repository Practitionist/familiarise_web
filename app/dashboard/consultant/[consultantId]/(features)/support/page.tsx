import { PersonalSupportRequests } from "@/app/support/_components/PersonalSupportRequests";
export default async function SupportPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  return <PersonalSupportRequests tree="consultant" profileId={consultantId} />;
}
