import { ConsulteeDocumentsPage } from "@/components/dashboard/consultee/resources/ConsulteeDocumentsPage";

export default async function ConsulteeDocumentsRoute({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  return <ConsulteeDocumentsPage consulteeId={consulteeId} />;
}
